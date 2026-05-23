// Opaque cursor for time+id-based pagination. We base64-encode a tuple of
// (receivedAt ISO, id) so the cursor is stable across deployments and
// matches the composite Prisma index `@@index([boothId, receivedAt, id])`.

export type Cursor = {
  receivedAt: string;
  id: string;
};

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(`${cursor.receivedAt}\t${cursor.id}`, "utf8").toString("base64url");

export const decodeCursor = (raw: string): Cursor | null => {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("\t");
    if (sep < 0) return null;
    const receivedAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!receivedAt || !id) return null;
    if (Number.isNaN(new Date(receivedAt).getTime())) return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
};
