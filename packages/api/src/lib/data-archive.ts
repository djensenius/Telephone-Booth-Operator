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

export const EXPORT_FORMAT = "telephone-booth-export";
export const EXPORT_VERSION = 1;

// Import order matters — parents before children so foreign keys resolve.
const IMPORT_ORDER = [
  "operatorUser",
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

const collectDump = async (): Promise<DataDump> =>
  // Read every table inside a single RepeatableRead transaction so the dump is
  // a consistent snapshot; concurrent writes can't produce child rows that
  // reference parents missing from the backup.
  db.$transaction(
    async (tx) => {
      const dump = {} as DataDump;
      for (const name of IMPORT_ORDER) {
        dump[name] = await modelClientOf(tx, name).findMany({});
      }
      return dump;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

// Build a full export archive: `manifest.json`, `data.json`, and one
// `blobs/<sha256>` entry per unique audio file that still exists in storage.
export const buildExportArchive = async (): Promise<{
  archive: Buffer;
  manifest: ExportManifest;
}> => {
  const dump = await collectDump();
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

// Restore an export archive into the current instance. Rows are upserted by id
// (idempotent) inside a single transaction, so a mid-restore failure never
// leaves a partially populated database. Each referenced audio blob is uploaded
// when the target storage does not already hold a byte-identical copy (verified
// by SHA-256), so truncated or corrupted target blobs are repaired rather than
// silently trusted.
export const restoreImportArchive = async (archive: Buffer): Promise<ImportSummary> => {
  const { dump, blobs } = parseArchive(archive);

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

  const rows: Record<string, number> = {};
  await db.$transaction(
    async (tx) => {
      for (const name of IMPORT_ORDER) {
        const client = modelClientOf(tx, name);
        let count = 0;
        for (const row of dump[name]) {
          await client.upsert({ where: { id: row.id }, create: row, update: row });
          count += 1;
        }
        rows[name] = count;
      }
    },
    // A full restore can touch many rows; allow well beyond the 5s default so
    // the whole database is applied atomically.
    { timeout: 120_000, maxWait: 10_000 },
  );

  return { rows, blobsUploaded, blobsSkipped };
};
