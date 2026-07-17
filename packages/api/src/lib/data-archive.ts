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
import { downloadBlob, headBlob, uploadBlob } from "./azure-blob.js";
import { createTar, readTar } from "./archive.js";
import { db } from "./db.js";

export const EXPORT_FORMAT = "telephone-booth-export";
export const EXPORT_VERSION = 1;

// Import order matters — parents before children so foreign keys resolve.
const IMPORT_ORDER = [
  "operatorUser",
  "file",
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

const modelClient = (
  name: ModelName,
): {
  findMany: (args?: unknown) => Promise<Row[]>;
  upsert: (args: unknown) => Promise<unknown>;
} =>
  (
    db as unknown as Record<
      ModelName,
      {
        findMany: (args?: unknown) => Promise<Row[]>;
        upsert: (args: unknown) => Promise<unknown>;
      }
    >
  )[name];

const collectDump = async (): Promise<DataDump> => {
  const dump = {} as DataDump;
  for (const name of IMPORT_ORDER) {
    dump[name] = await modelClient(name).findMany({});
  }
  return dump;
};

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
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) {
    throw new ImportFormatError(`unexpected archive format: ${manifest.format}`);
  }
  if (manifest.version > EXPORT_VERSION) {
    throw new ImportFormatError(`archive version ${manifest.version} is newer than supported`);
  }
  const dump = JSON.parse(dataRaw.toString("utf8")) as Partial<DataDump>;

  const blobs = new Map<string, Buffer>();
  for (const [name, data] of byName) {
    if (name.startsWith("blobs/")) blobs.set(name.slice("blobs/".length), data);
  }

  const normalized = {} as DataDump;
  for (const name of IMPORT_ORDER) normalized[name] = dump[name] ?? [];

  return { manifest, dump: normalized, blobs };
};

// Restore an export archive into the current instance. Rows are upserted by id
// (idempotent), and each referenced audio blob is uploaded only when the
// target storage does not already hold it (dedupe by blobKey). SHA-256 is
// verified against the archived bytes before upload.
export const restoreImportArchive = async (archive: Buffer): Promise<ImportSummary> => {
  const { dump, blobs } = parseArchive(archive);

  let blobsUploaded = 0;
  let blobsSkipped = 0;
  const uploadedKeys = new Set<string>();

  for (const raw of dump.file) {
    const file = raw as FileRow;
    if (uploadedKeys.has(file.blobKey)) continue;
    uploadedKeys.add(file.blobKey);
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
    if (head.exists) {
      blobsSkipped += 1;
      continue;
    }
    await uploadBlob(file.blobKey, data, { contentType: file.contentType, sha256: file.sha256 });
    blobsUploaded += 1;
  }

  const rows: Record<string, number> = {};
  for (const name of IMPORT_ORDER) {
    const client = modelClient(name);
    let count = 0;
    for (const row of dump[name]) {
      await client.upsert({ where: { id: row.id }, create: row, update: row });
      count += 1;
    }
    rows[name] = count;
  }

  return { rows, blobsUploaded, blobsSkipped };
};
