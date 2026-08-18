import { Hono } from "hono";
import {
  ImportFormatError,
  buildExportArchive,
  restoreImportArchive,
} from "../lib/data-archive.js";
import { recordAudit } from "../lib/audit.js";
import { observeModerationQueue } from "../lib/push-events.js";
import { requireAdmin, type AuthVariables } from "../lib/session.js";

export const adminDataRouter = new Hono<{ Variables: AuthVariables }>();

// Admin-only. Streams a full tar backup (database dump + all audio) as a file
// download. See lib/data-archive.ts for what is and isn't included.
adminDataRouter.get("/export", requireAdmin(), async (c) => {
  const { archive, manifest } = await buildExportArchive();
  const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
  return c.body(archive as unknown as ArrayBuffer, 200, {
    "content-type": "application/x-tar",
    "content-disposition": `attachment; filename="telephone-booth-export-${stamp}.tar"`,
    "content-length": String(archive.byteLength),
  });
});

// Admin-only. Restores a previously exported archive into this instance.
// Accepts the raw tar body (application/x-tar or octet-stream).
adminDataRouter.post("/import", requireAdmin(), async (c) => {
  const body = Buffer.from(await c.req.arrayBuffer());
  recordAudit(c, {
    action: "admin.data.import",
    targetType: "instance",
    metadata: { sizeBytes: body.byteLength },
  });
  if (body.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  try {
    const summary = await restoreImportArchive(body);
    void observeModerationQueue("admin.data.import");
    recordAudit(c, { metadata: { summary: JSON.stringify(summary) } });
    return c.json(summary);
  } catch (error) {
    if (error instanceof ImportFormatError) {
      return c.json({ error: "invalid_archive", message: error.message }, 400);
    }
    throw error;
  }
});
