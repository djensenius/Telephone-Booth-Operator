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
  contentType: string,
): string => {
  const prefix =
    kind === "message" ? "messages" : kind === "question-audio" ? "questions" : "instructions";
  const extension: Record<string, string> = {
    "audio/flac": "flac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/aiff": "aiff",
    "audio/x-aiff": "aiff",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
  };
  return `${prefix}/${sha256.slice(0, 2)}/${sha256}.${extension[contentType]}`;
};

export const uploadsRouter = new Hono<{ Variables: AuthVariables }>();

uploadsRouter.post("/sas", zValidator("json", UploadSasRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const existing =
    body.kind === "question-audio" || body.kind === "instruction-audio"
      ? await db.file.findUnique({ where: { sha256: body.sha256 } })
      : null;
  const blobName = existing?.blobKey ?? blobNameFor(body.kind, body.sha256, body.contentType);
  // The SAS URL itself is a short-lived credential and is never recorded.
  recordAudit(c, {
    action: "upload.sas.issue",
    targetType: "file",
    targetId: body.sha256,
    metadata: { kind: body.kind, sizeBytes: body.sizeBytes, contentType: body.contentType },
  });

  let audioFileId: string | undefined;
  if (body.kind === "question-audio" || body.kind === "instruction-audio") {
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
