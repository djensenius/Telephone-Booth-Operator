import { zValidator } from "@hono/zod-validator";
import { UploadSasRequestSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.js";
import { generateSasUrl } from "../lib/azure-blob.js";
import { db } from "../lib/db.js";
import type { AuthVariables } from "../lib/session.js";

const blobNameFor = (
  kind: "message" | "question-audio" | "instruction-audio",
  sha256: string,
): string => {
  const prefix =
    kind === "message" ? "messages" : kind === "question-audio" ? "questions" : "instructions";
  return `${prefix}/${sha256.slice(0, 2)}/${sha256}.flac`;
};

export const uploadsRouter = new Hono<{ Variables: AuthVariables }>();

uploadsRouter.post("/sas", zValidator("json", UploadSasRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const blobName = blobNameFor(body.kind, body.sha256);
  // The SAS URL itself is a short-lived credential and is never recorded.
  recordAudit(c, {
    action: "upload.sas.issue",
    targetType: "file",
    targetId: body.sha256,
    metadata: { kind: body.kind, sizeBytes: body.sizeBytes, contentType: body.contentType },
  });

  let audioFileId: string | undefined;
  if (body.kind === "question-audio" || body.kind === "instruction-audio") {
    const existing = await db.file.findUnique({ where: { sha256: body.sha256 } });
    const file =
      existing ??
      (await db.file.create({
        data: {
          blobContainer: process.env.AZURE_BLOB_CONTAINER?.trim() || "booth-recordings",
          blobKey: blobName,
          sha256: body.sha256,
          sizeBytes: body.sizeBytes,
          durationMs: null,
          contentType: body.contentType,
        },
      }));
    audioFileId = file.id;
  }

  const sas = generateSasUrl(blobName, { permissions: "cw", contentType: body.contentType });
  return c.json(
    {
      uploadUrl: sas.url,
      blobName,
      expiresAt: sas.expiresAt.toISOString(),
      ...(audioFileId ? { audioFileId } : {}),
    },
    201,
  );
});
