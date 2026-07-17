/**
 * Admin data backup CLI — thin wrapper around the operator API's
 * `/v1/admin/data/export` and `/v1/admin/data/import` endpoints. Both
 * endpoints are admin-only, so provide credentials for an operator who
 * belongs to the Authentik admin group.
 *
 * Usage:
 *   OPERATOR_API_URL=https://operator.example \
 *   OPERATOR_TOKEN=<operator-bearer-token> \
 *     pnpm --filter @telephone-booth-operator/api exec tsx ../../tools/data-backup.ts export ./backup.tar
 *
 *   OPERATOR_API_URL=... OPERATOR_TOKEN=... \
 *     tsx tools/data-backup.ts import ./backup.tar
 *
 * Auth: set OPERATOR_TOKEN (an operator bearer token) or OPERATOR_COOKIE
 * (a raw session cookie header value, e.g. copied from the browser).
 */

import { readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.OPERATOR_API_URL?.replace(/\/$/, "");
const token = process.env.OPERATOR_TOKEN;
const cookie = process.env.OPERATOR_COOKIE;

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!baseUrl) die("OPERATOR_API_URL is required (e.g. https://operator.example)");
if (!token && !cookie) die("Set OPERATOR_TOKEN or OPERATOR_COOKIE for an admin operator");

const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  return headers;
};

const [command, file] = process.argv.slice(2);

const runExport = async (outFile: string): Promise<void> => {
  const res = await fetch(`${baseUrl}/v1/admin/data/export`, { headers: authHeaders() });
  if (!res.ok) die(`export failed: ${res.status} ${await res.text()}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(outFile, buffer);
  console.log(`Wrote ${buffer.byteLength} bytes to ${outFile}`);
};

const runImport = async (inFile: string): Promise<void> => {
  const body = await readFile(inFile);
  const res = await fetch(`${baseUrl}/v1/admin/data/import`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/x-tar" },
    body,
  });
  const text = await res.text();
  if (!res.ok) die(`import failed: ${res.status} ${text}`);
  console.log(`Import complete: ${text}`);
};

if (command === "export") {
  if (!file) die("usage: data-backup.ts export <outfile.tar>");
  await runExport(file);
} else if (command === "import") {
  if (!file) die("usage: data-backup.ts import <infile.tar>");
  await runImport(file);
} else {
  die("usage: data-backup.ts <export|import> <file.tar>");
}
