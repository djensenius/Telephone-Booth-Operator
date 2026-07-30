// Admin-only full data export/import. Bundles the entire Postgres data set
// (minus ephemeral OIDC session credentials) together with every audio blob
// into a single tar archive, and restores such an archive into a target
// instance. Audio is content-addressed by SHA-256 so identical recordings are
// stored once; blob integrity metadata is preserved on restore.
//
// Deliberately excluded from the export:
//   * OperatorSession — holds live id/access/refresh tokens (plaintext
//     credentials); sessions are ephemeral and must not travel in a backup.
//   * SAS URLs — never materialised into the archive; only the stable
//     blobKey/sha256 are stored, so scope/lifetime rules are untouched.

import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { downloadBlob, headBlob, uploadBlob } from "./azure-blob.js";
import { createTar, readTar } from "./archive.js";
import { db } from "./db.js";
import { closeOutInstallation, invalidateActiveInstallationCache } from "./installation.js";

export const EXPORT_FORMAT = "telephone-booth-export";
// 1: original shape. 2: BoothStatusSnapshot carries `firstSeenAt`/`repeatCount`.
// 3: rows carry `installationId` and the archive may be scoped to one
// installation. Bumped so a server that predates the collapse rejects the
// archive as newer than supported instead of failing on unknown columns
// mid-restore. Older archives still import — `withStatusWindow` fills the
// missing window, and legacy untagged rows are adopted into a deterministic
// ended "Restored …" installation after the archived rows are upserted.
export const EXPORT_VERSION = 3;
// Manifest models added after v1. Nothing to migrate; listed for the record.
const INSTALLATION_MODEL = "installation" as const;

// Import order matters — parents before children so foreign keys resolve.
const IMPORT_ORDER = [
  "operatorUser",
  INSTALLATION_MODEL,
  "file",
  "instruction",
  "question",
  "callSession",
  "message",
  "boothEvent",
  "boothStatusSnapshot",
  "apiToken",
  "transcription",
  "moderation",
  "metricFilter",
  "mobileDevice",
] as const;

type ModelName = (typeof IMPORT_ORDER)[number];

type Row = Record<string, unknown> & { id: string | number };
type FileRow = Row & { blobKey: string; sha256: string; contentType: string };

type DataDump = Record<ModelName, Row[]>;

export type ExportManifest = {
  format: string;
  version: number;
  generatedAt: string;
  container: string | null;
  counts: Record<string, number>;
  blobCount: number;
  missingBlobs: string[];
  // Installations present only because a row of the exported era points at one
  // of their prompts. None of their own data travels, so a restore must not
  // treat their (deliberately emptied) counters as authoritative. Absent on
  // archives written before this field existed.
  partialInstallationIds?: string[];
};

export type ImportSummary = {
  rows: Record<string, number>;
  blobsUploaded: number;
  blobsSkipped: number;
};

type ModelDelegate = {
  findMany: (args?: unknown) => Promise<Row[]>;
  upsert: (args: unknown) => Promise<unknown>;
};

const modelClientOf = (client: unknown, name: ModelName): ModelDelegate =>
  (client as Record<ModelName, ModelDelegate>)[name];

const collectDump = async (installationId?: string): Promise<DataDump> =>
  // Read every table inside a single RepeatableRead transaction so the dump is
  // a consistent snapshot; concurrent writes can't produce child rows that
  // reference parents missing from the backup.
  db.$transaction(
    async (tx) => {
      const dump = {} as DataDump;
      for (const name of IMPORT_ORDER) {
        if (installationId && name === "operatorUser") continue;
        dump[name] = await modelClientOf(tx, name).findMany(
          installationId ? scopedFindArgs(name, installationId) : {},
        );
      }
      // A carried-over question drags its own era in as a parent row, but none
      // of that era's data travels. Shipping its frozen summary would restore
      // an installation claiming a full run's counters with an empty
      // drill-down, so the parent arrives without counters and says why.
      if (installationId) {
        dump[INSTALLATION_MODEL] = dump[INSTALLATION_MODEL].map((row) =>
          row.id === installationId
            ? row
            : {
                ...row,
                summary: null,
                notes: [
                  row.notes,
                  "Partial: included only as the source of a prompt used by another installation.",
                ]
                  .filter((part) => part != null && part !== "")
                  .join("\n"),
              },
        );
      }

      // Operators are global, but a scoped archive is a per-era artifact that
      // gets handed around (it is what the purge flow offers as a safety
      // copy), so it carries only the accounts its own rows point at rather
      // than the whole staff directory.
      if (installationId) {
        const ids = referencedOperatorIds(dump);
        dump.operatorUser =
          ids.length > 0
            ? await modelClientOf(tx, "operatorUser").findMany({ where: { id: { in: ids } } })
            : [];
      }
      return dump;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      // A long run's era is far more than Prisma's five-second interactive
      // default can read, and the pre-purge download must not time out.
      timeout: 120_000,
      maxWait: 10_000,
    },
  );

// Columns pointing at `OperatorUser` from the models a scoped export collects.
// `apiToken.createdByUserId` is absent on purpose: scoped archives omit tokens.
const OPERATOR_REFERENCES: Partial<Record<ModelName, readonly string[]>> = {
  [INSTALLATION_MODEL]: ["endedById"],
  message: ["decidedById"],
  transcription: ["requestedById"],
  moderation: ["requestedById"],
};

const referencedOperatorIds = (dump: Partial<DataDump>): string[] => {
  const ids = new Set<string>();
  for (const [name, fields] of Object.entries(OPERATOR_REFERENCES) as [
    ModelName,
    readonly string[],
  ][]) {
    for (const row of dump[name] ?? []) {
      for (const field of fields) {
        const value = row[field];
        if (typeof value === "string") ids.add(value);
      }
    }
  }
  return [...ids];
};

// Models carrying an `installationId` column can be filtered directly.
const SCOPED_MODELS = new Set<ModelName>([
  "question",
  "message",
  "callSession",
  "boothEvent",
  "boothStatusSnapshot",
]);

// Build the `findMany` args for a single-installation export. Directly scoped
// models filter on `installationId`; models that hang off a scoped parent are
// filtered through the relation so a scoped archive stays self-consistent.
// Instructions are global and travel whole because they are booth
// configuration rather than era data; tokens, devices and metric filters are
// dropped entirely and operators are narrowed to the referenced accounts.
// The relation filters are annotated so the compiler checks them. The dump
// walks models generically, so `findMany` is otherwise reached through an
// untyped client and a wrong relation name would only surface as a Prisma
// validation error at runtime, on the export path, in production.
// A straggler recording is filed in the era that was open when it landed while
// its question stays with the era that issued it, so a scoped export cannot
// filter questions on their own era alone: leaving the referenced row out makes
// the archive fail its own foreign key on restore.
const questionScopeArgs = (installationId: string): Prisma.QuestionFindManyArgs => ({
  where: {
    OR: [{ installationId }, { messages: { some: { installationId } } }],
  },
});

const fileScopeArgs = (installationId: string): Prisma.FileFindManyArgs => ({
  where: {
    OR: [
      // A file can back several questions once an era copies them forward,
      // so this is a list filter, not a to-one one.
      { questions: { some: { installationId } } },
      // ...and the audio of a question only reachable through a straggler
      // message has to travel too, for the same reason.
      { questions: { some: { messages: { some: { installationId } } } } },
      { message: { installationId } },
      // Instructions are global, but their audio must travel with any
      // archive or a restore would leave dangling references.
      { instruction: { isNot: null } },
    ],
  },
});

const transcriptionScopeArgs = (installationId: string): Prisma.TranscriptionFindManyArgs => ({
  where: { message: { installationId } },
});

const moderationScopeArgs = (installationId: string): Prisma.ModerationFindManyArgs => ({
  where: { message: { installationId } },
});

// Global tables holding credentials or personal data that no scoped row
// references. A per-era archive has no use for them, and shipping API-token
// hashes or push-device registrations inside a downloadable safety copy would
// spread secrets around for nothing.
const EXCLUDED_FROM_SCOPED_EXPORT = new Set<ModelName>([
  "apiToken",
  "mobileDevice",
  "metricFilter",
]);

// The era being exported, plus any era a carried-over question still belongs
// to. Without the parent row the archive would reference an installation it
// does not contain, and the restore would fail that foreign key.
const installationScopeArgs = (installationId: string): Prisma.InstallationFindManyArgs => ({
  where: {
    OR: [
      { id: installationId },
      { questions: { some: { messages: { some: { installationId } } } } },
    ],
  },
});

const scopedFindArgs = (name: ModelName, installationId: string): unknown => {
  if (name === INSTALLATION_MODEL) return installationScopeArgs(installationId);
  if (name === "question") return questionScopeArgs(installationId);
  if (SCOPED_MODELS.has(name)) return { where: { installationId } };
  if (name === "transcription") return transcriptionScopeArgs(installationId);
  if (name === "moderation") return moderationScopeArgs(installationId);
  if (name === "file") return fileScopeArgs(installationId);
  // `id: { in: [] }` rather than a skipped read: the dump is keyed by model and
  // every entry must exist, empty or not.
  if (EXCLUDED_FROM_SCOPED_EXPORT.has(name)) return { where: { id: { in: [] } } };
  return {};
};

// Build an export archive: `manifest.json`, `data.json`, and one
// `blobs/<sha256>` entry per unique audio file that still exists in storage.
// Passing `installationId` narrows the dump to a single installation (used for
// the per-era download offered before a purge); omitting it exports
// the whole instance.
export const buildExportArchive = async (
  options: { installationId?: string } = {},
): Promise<{
  archive: Buffer;
  manifest: ExportManifest;
}> => {
  const dump = await collectDump(options.installationId);
  const counts: Record<string, number> = {};
  for (const name of IMPORT_ORDER) counts[name] = dump[name].length;

  const blobEntries: { name: string; data: Buffer }[] = [];
  const seenSha = new Set<string>();
  const missingBlobs: string[] = [];
  let container: string | null = null;

  for (const raw of dump.file) {
    const file = raw as FileRow;
    container = (file.blobContainer as string | undefined) ?? container;
    if (seenSha.has(file.sha256)) continue;
    seenSha.add(file.sha256);
    const head = await headBlob(file.blobKey);
    if (!head.exists) {
      missingBlobs.push(file.sha256);
      continue;
    }
    const data = await downloadBlob(file.blobKey);
    blobEntries.push({ name: `blobs/${file.sha256}`, data });
  }

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: new Date().toISOString(),
    container,
    counts,
    blobCount: blobEntries.length,
    missingBlobs,
    partialInstallationIds: options.installationId
      ? dump[INSTALLATION_MODEL]
          .filter((row) => row.id !== options.installationId)
          .map((row) => String(row.id))
      : [],
  };

  const archive = createTar([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    { name: "data.json", data: Buffer.from(JSON.stringify(dump), "utf8") },
    ...blobEntries,
  ]);

  return { archive, manifest };
};

export class ImportFormatError extends Error {}

const parseJson = (raw: Buffer, what: string): unknown => {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new ImportFormatError(
      `${what} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    );
  }
};

const parseArchive = (
  archive: Buffer,
): { manifest: ExportManifest; dump: DataDump; blobs: Map<string, Buffer> } => {
  const entries = readTar(archive);
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));

  const manifestRaw = byName.get("manifest.json");
  const dataRaw = byName.get("data.json");
  if (!manifestRaw || !dataRaw) {
    throw new ImportFormatError("archive missing manifest.json or data.json");
  }
  const manifestValue = parseJson(manifestRaw, "manifest.json");
  if (typeof manifestValue !== "object" || manifestValue === null) {
    throw new ImportFormatError("manifest.json is not an object");
  }
  const manifest = manifestValue as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) {
    throw new ImportFormatError(`unexpected archive format: ${String(manifest.format)}`);
  }
  if (typeof manifest.version !== "number") {
    throw new ImportFormatError("manifest.json is missing a numeric version");
  }
  if (manifest.version > EXPORT_VERSION) {
    throw new ImportFormatError(`archive version ${manifest.version} is newer than supported`);
  }
  // The manifest is attacker-controlled input like the rest of the tar, so the
  // optional field is checked rather than trusted: a malformed one must be a
  // 400 invalid_archive, not a TypeError surfacing as a 500.
  const partial: unknown = manifest.partialInstallationIds;
  if (
    partial !== undefined &&
    (!Array.isArray(partial) || partial.some((id) => typeof id !== "string"))
  ) {
    throw new ImportFormatError("manifest.json partialInstallationIds is not an array of strings");
  }

  const dumpValue = parseJson(dataRaw, "data.json");
  if (typeof dumpValue !== "object" || dumpValue === null) {
    throw new ImportFormatError("data.json is not an object");
  }
  const dump = dumpValue as Partial<DataDump>;

  const blobs = new Map<string, Buffer>();
  for (const [name, data] of byName) {
    if (name.startsWith("blobs/")) blobs.set(name.slice("blobs/".length), data);
  }

  const normalized = {} as DataDump;

  for (const name of IMPORT_ORDER) {
    const rows = dump[name] ?? [];
    if (!Array.isArray(rows)) {
      throw new ImportFormatError(`data.json entry "${name}" must be an array`);
    }
    normalized[name] = name === "boothStatusSnapshot" ? rows.map(withStatusWindow) : rows;
  }

  return { manifest, dump: normalized, blobs };
};

// Archives written before status collapsing carry no window on a snapshot. The
// column defaults to `now()`, which would date a restored row to the restore
// rather than to the report, so mirror the migration and start the window at
// the report time.
const withStatusWindow = (row: Row): Row =>
  row.firstSeenAt === undefined || row.firstSeenAt === null
    ? { ...row, firstSeenAt: row.updatedAt, repeatCount: row.repeatCount ?? 1 }
    : row;

const dateFromManifest = (manifest: ExportManifest): Date => {
  const generated = new Date(manifest.generatedAt);
  return Number.isNaN(generated.getTime()) ? new Date(0) : generated;
};

const restoredInstallationId = (manifest: ExportManifest): string => {
  const bytes = createHash("sha256")
    .update(`${EXPORT_FORMAT}:legacy-restore:${manifest.version}:${manifest.generatedAt}`)
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

const adoptLegacyRows = async (
  tx: Prisma.TransactionClient,
  manifest: ExportManifest,
  dump: DataDump,
): Promise<void> => {
  if (manifest.version >= 3) return;

  const installationId = restoredInstallationId(manifest);
  const generatedAt = dateFromManifest(manifest);
  const generatedLabel = generatedAt.toISOString();

  await tx.installation.upsert({
    where: { id: installationId },
    create: {
      id: installationId,
      name: `Restored ${generatedLabel}`,
      notes: `Created during import of legacy archive version ${manifest.version}.`,
      startedAt: generatedAt,
      endedAt: generatedAt,
    },
    update: {},
  });

  // Adopt by id, not by "still untagged". Restoring a legacy archive in place
  // hits rows the migration already backfilled into the current era; those
  // carry a non-null id and would otherwise be left polluting it.
  const idsOf = (name: ModelName): string[] =>
    dump[name].map((row) => String(row.id)).filter((id) => id.length > 0);
  const adopt = (name: ModelName): { id: { in: string[] } } => ({ id: { in: idsOf(name) } });

  await Promise.all([
    tx.question.updateMany({ where: adopt("question"), data: { installationId } }),
    tx.message.updateMany({ where: adopt("message"), data: { installationId } }),
    tx.callSession.updateMany({ where: adopt("callSession"), data: { installationId } }),
    tx.boothEvent.updateMany({ where: adopt("boothEvent"), data: { installationId } }),
    // Snapshots key on an integer id.
    tx.boothStatusSnapshot.updateMany({
      where: { id: { in: dump.boothStatusSnapshot.map((row) => Number(row.id)) } },
      data: { installationId },
    }),
  ]);

  // The era is created already ended, so it has to satisfy the same invariants
  // a rollover leaves behind: nothing open, nothing queued, nothing live, and
  // counters frozen. Otherwise a legacy archive's pending messages keep
  // feeding the moderation badge from an era nobody can reopen.
  const summary = await closeOutInstallation(tx, installationId, generatedAt);
  await tx.installation.update({ where: { id: installationId }, data: { summary } });
};

// Only one installation may be open at a time, enforced by a partial unique
// index. A restore therefore cannot blindly upsert an archive whose active era
// differs from the target's: the target was seeded with its own active row by
// the migration (or lazily by a booth write) and the insert would collide.
//
// The archive is authoritative for a restore, so the target's era yields: it is
// closed out rather than deleted, even when nothing was recorded against it.
// Deleting it would strand any replica whose cached active id still names it —
// the next booth write there would fail its foreign key, and a booth write must
// never fail on bookkeeping. An empty ended era is cheap; a dropped recording
// is not.
const reconcileActiveInstallation = async (
  tx: Prisma.TransactionClient,
  dump: Record<string, Row[]>,
): Promise<void> => {
  const incoming = (dump[INSTALLATION_MODEL] ?? []).find((row) => row.endedAt == null);
  if (!incoming) return;

  const existing = await tx.installation.findFirst({ where: { endedAt: null } });
  if (!existing || existing.id === incoming.id) return;

  // Not just a timestamp: the era gets the same treatment the rollover gives
  // it, so the restored instance never inherits open sessions, a moderation
  // queue that keeps feeding the badge from a dead era, or missing counters.
  const endedAt = new Date();
  const summary = await closeOutInstallation(tx, existing.id, endedAt);
  await tx.installation.update({
    where: { id: existing.id },
    data: {
      endedAt,
      summary,
      notes: [existing.notes, "Closed automatically to restore an archive."]
        .filter((part) => part != null && part !== "")
        .join("\n"),
    },
  });
};

// Restore an export archive into the current instance. Rows are upserted by id
// (idempotent) inside a single transaction, so a mid-restore failure never
// leaves a partially populated database. Each referenced audio blob is uploaded
// when the target storage does not already hold a byte-identical copy (verified
// by SHA-256), so truncated or corrupted target blobs are repaired rather than
// silently trusted.
export const restoreImportArchive = async (archive: Buffer): Promise<ImportSummary> => {
  const { manifest, dump, blobs } = parseArchive(archive);

  let blobsUploaded = 0;
  let blobsSkipped = 0;
  const handledKeys = new Set<string>();

  for (const raw of dump.file) {
    const file = raw as FileRow;
    if (handledKeys.has(file.blobKey)) continue;
    handledKeys.add(file.blobKey);
    const data = blobs.get(file.sha256);
    if (!data) {
      blobsSkipped += 1;
      continue;
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== file.sha256) {
      throw new ImportFormatError(`blob sha256 mismatch for ${file.sha256}`);
    }
    const head = await headBlob(file.blobKey);
    if (head.exists && head.sha256 === file.sha256) {
      // Target already holds a blob whose recorded integrity hash matches — safe
      // to skip. A missing or mismatched hash means we cannot trust the existing
      // bytes, so we re-upload the archive's verified copy below.
      blobsSkipped += 1;
      continue;
    }
    await uploadBlob(file.blobKey, data, { contentType: file.contentType, sha256: file.sha256 });
    blobsUploaded += 1;
  }

  const partialInstallations = new Set(manifest.partialInstallationIds ?? []);
  const rows: Record<string, number> = {};
  await db.$transaction(
    async (tx) => {
      await reconcileActiveInstallation(tx, dump);
      for (const name of IMPORT_ORDER) {
        const client = modelClientOf(tx, name);
        let count = 0;
        for (const row of dump[name]) {
          // A partial parent era carries no counters of its own (see the
          // export side), so applying it over a real row would erase that
          // row's frozen summary. Create it on a target that lacks it, leave
          // it alone on a target that already knows the real thing.
          const update =
            name === INSTALLATION_MODEL && partialInstallations.has(String(row.id)) ? {} : row;
          await client.upsert({ where: { id: row.id }, create: row, update });
          count += 1;
        }
        rows[name] = count;
      }
      await adoptLegacyRows(tx, manifest, dump);
    },
    // A full restore can touch many rows; allow well beyond the 5s default so
    // the whole database is applied atomically.
    { timeout: 120_000, maxWait: 10_000 },
  );

  // A restore can replace which era is open, so the cached id is now suspect.
  invalidateActiveInstallationCache();

  return { rows, blobsUploaded, blobsSkipped };
};
