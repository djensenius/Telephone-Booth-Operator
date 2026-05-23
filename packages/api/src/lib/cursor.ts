// Opaque cursor for time+id-based pagination. We base64-encode a tuple of
// (timestamp ISO, id) so the cursor is stable across deployments and
// matches composite Prisma indexes like `@@index([boothId, receivedAt, id])`
// or `@@index([boothId, startedAt])`. The `timestamp` field is generic so
// the same cursor type works for both `BoothEvent.receivedAt` and
// `CallSession.startedAt`.

export type Cursor = {
  timestamp: string;
  id: string;
};

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(`${cursor.timestamp}\t${cursor.id}`, "utf8").toString("base64url");

export const decodeCursor = (raw: string): Cursor | null => {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("\t");
    if (sep < 0) return null;
    const timestamp = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!timestamp || !id) return null;
    if (Number.isNaN(new Date(timestamp).getTime())) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
};
