// Installations — start a new era, close out the current one, browse past
// runs, and (irreversibly) purge one.
//
// Ending an installation is the "clear everything and start fresh" operation.
// It is deliberately NOT a delete: rows keep their `installationId` and stay
// readable under that scope. What it does do is freeze the summary counters,
// close out anything still open, and empty the moderation queue so the next
// era starts clean. See lib/installation.ts for the scoping helpers.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  InstallationCreateSchema,
  InstallationEndSchema,
  InstallationPurgeSchema,
  InstallationUpdateSchema,
  type InstallationPurgeResult,
} from "@telephone-booth-operator/shared";
import { recordAudit } from "../lib/audit.js";
import { deleteBlob } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { buildExportArchive } from "../lib/data-archive.js";
import { db } from "../lib/db.js";
import { Prisma, type Installation } from "../generated/prisma/client.js";
import {
  closeOutInstallation,
  findActiveInstallation,
  invalidateActiveInstallationCache,
  nextInstallationName,
  serializeInstallation,
} from "../lib/installation.js";
import { log } from "../lib/logger.js";
import { requireAdmin, requireOperator, type AuthVariables } from "../lib/session.js";
import { invalidateStatsCaches } from "./stats.js";

// How many blob deletions a purge has in flight at once.
const PURGE_BLOB_CONCURRENCY = 8;

// Rollover and purge both touch every row of an era, which a long booth run can
// make far larger than Prisma's five-second interactive default allows for.
const BULK_TRANSACTION = { timeout: 120_000, maxWait: 10_000 };

export const installationsRouter = new Hono<{ Variables: AuthVariables }>();

const idParamSchema = z.object({ id: z.guid() });

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// Any operator can read the history; only admins can change it.
installationsRouter.get("/", requireOperator(), async (c) => {
  const rows = await db.installation.findMany({ orderBy: [{ startedAt: "desc" }] });
  return c.json({ items: rows.map(serializeInstallation) });
});

// The currently active era. Mounted before "/:id" so "current" is not parsed
// as a uuid path param.
installationsRouter.get("/current", requireOperator(), async (c) => {
  const active = await findActiveInstallation();
  if (!active) return c.json({ error: "no_active_installation" }, 404);
  return c.json(serializeInstallation(active));
});

installationsRouter.get(
  "/:id",
  requireOperator(),
  zValidator("param", idParamSchema),
  async (c) => {
    const row = await db.installation.findUnique({ where: { id: c.req.valid("param").id } });
    if (!row) return c.json({ error: "installation_not_found" }, 404);
    return c.json(serializeInstallation(row));
  },
);

// Start a new installation. If one is active, close it out first in the same
// transaction so booth heartbeats cannot leave the operator stuck between
// "ended the old era" and "named the new one".
installationsRouter.post(
  "/",
  requireAdmin(),
  zValidator("json", InstallationCreateSchema),
  async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    const endedAt = new Date();

    const result = await db
      .$transaction(async (tx) => {
        const data = {
          name: body.name.length > 0 ? body.name : await nextInstallationName(),
          notes: body.notes ?? null,
          location: body.location ?? null,
          defaultTranscriptionLanguage: body.defaultTranscriptionLanguage ?? null,
        };

        let previous = await tx.installation.findFirst({
          where: { endedAt: { not: null } },
          orderBy: [{ endedAt: "desc" }],
        });
        let ended: Installation | undefined;
        const active = await tx.installation.findFirst({
          where: { endedAt: null },
          orderBy: [{ startedAt: "desc" }],
        });
        if (active) {
          const claimed = await tx.installation.updateMany({
            where: { id: active.id, endedAt: null },
            data: { endedAt },
          });
          if (claimed.count === 0) return null;
          const summary = await closeOutInstallation(tx, active.id, endedAt);
          ended = await tx.installation.update({
            where: { id: active.id },
            data: { endedAt, endedById: user?.id ?? null, summary },
          });
          previous = ended;
        }

        const installation = await tx.installation.create({ data });

        // Copied questions point at the *same* `File` row as the original, so
        // the audio is shared rather than re-uploaded and SHA-256 dedupe is
        // preserved. This is why `Question.audioId` is not unique, and why the
        // purge below refcounts `File` rows before deleting any blob.
        //
        // If this request closed an active era, questions carry from that era;
        // otherwise they carry from the last era that had already been closed.
        // Ending an installation archives the questions that were live at the
        // time, stamping `retiredAt` with the era's `endedAt`. That stamp is
        // what lets us tell "was live when the era ended" apart from "the
        // operator retired this months ago", so both it and any remaining
        // drafts are what carry forward.
        if (body.copyQuestions && previous) {
          const source = await tx.question.findMany({
            where: {
              installationId: previous.id,
              OR: [
                { status: { in: ["active", "draft"] } },
                ...(previous.endedAt
                  ? [{ status: "archived", retiredAt: previous.endedAt } as const]
                  : []),
              ],
            },
          });
          // The destination has just been created, but keep the duplicate
          // guards local so a future source path cannot trip per-era uniqueness
          // over a prompt or recording it already holds.
          const existing = await tx.question.findMany({
            where: { installationId: installation.id },
            select: { prompt: true, audioId: true },
          });
          const existingPrompts = new Set(existing.map((row) => row.prompt));
          // Audio is unique per era too, so skip a recording that is already
          // present under a different prompt.
          const existingAudio = new Set(existing.map((row) => row.audioId));
          for (const question of source) {
            if (existingPrompts.has(question.prompt)) continue;
            if (existingAudio.has(question.audioId)) continue;
            await tx.question.create({
              data: {
                prompt: question.prompt,
                // Drafts stay drafts; anything that was live (or was archived by
                // the rollover) comes back live in the new era.
                status: question.status === "draft" ? "draft" : "active",
                audioId: question.audioId,
                installationId: installation.id,
              },
            });
            existingPrompts.add(question.prompt);
            existingAudio.add(question.audioId);
          }
        }

        return { created: installation, ended };
      }, BULK_TRANSACTION)
      .catch((err: unknown) => {
        // Two admins starting an era at once: the loser trips the partial unique
        // index that keeps exactly one era open. That is the same situation the
        // precheck reports, so report it the same way rather than as a 500.
        if (isUniqueViolation(err)) return null;
        throw err;
      });

    if (!result) {
      const winner = await findActiveInstallation();
      return c.json(
        { error: "installation_already_active", ...(winner ? { installationId: winner.id } : {}) },
        409,
      );
    }

    invalidateActiveInstallationCache();
    invalidateStatsCaches();
    if (result.ended) {
      const endedDto = serializeInstallation(result.ended);
      wsBroadcaster.broadcast({ kind: "installation", installation: endedDto });
      log.info({ installationId: result.ended.id }, "installation ended before start");
    }
    const created = result.created;
    const dto = serializeInstallation(created);
    wsBroadcaster.broadcast({ kind: "installation", installation: dto });
    log.info(
      { installationId: created.id, copyQuestions: body.copyQuestions },
      "installation started",
    );
    recordAudit(c, {
      action: result.ended ? "installation.rollover" : "installation.start",
      targetType: "installation",
      targetId: created.id,
      metadata: result.ended
        ? {
            startedInstallationId: created.id,
            startedInstallationName: created.name,
            endedInstallationId: result.ended.id,
            endedInstallationName: result.ended.name,
            copyQuestions: body.copyQuestions === true,
          }
        : { name: created.name, copyQuestions: body.copyQuestions === true },
    });
    return c.json(dto, 201);
  },
);

installationsRouter.patch(
  "/:id",
  requireAdmin(),
  zValidator("param", idParamSchema),
  zValidator("json", InstallationUpdateSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await db.installation.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "installation_not_found" }, 404);

    const updated = await db.installation.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.defaultTranscriptionLanguage !== undefined
          ? { defaultTranscriptionLanguage: body.defaultTranscriptionLanguage }
          : {}),
      },
    });
    recordAudit(c, {
      action: "installation.update",
      targetType: "installation",
      targetId: id,
      metadata: { fields: Object.keys(body) },
    });
    return c.json(serializeInstallation(updated));
  },
);

// Close out the active installation. This is the "archive everything and start
// fresh" action. Nothing is deleted.
installationsRouter.post(
  "/:id/end",
  requireAdmin(),
  zValidator("param", idParamSchema),
  zValidator("json", InstallationEndSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("user");

    const existing = await db.installation.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "installation_not_found" }, 404);
    if (existing.endedAt) return c.json({ error: "installation_already_ended" }, 409);

    const endedAt = new Date();
    const ended = await db.$transaction(async (tx) => {
      // Claim the era before doing anything else. Two admins ending it at once
      // would otherwise both proceed, and the second `endedAt` would no longer
      // match the `retiredAt` the first stamped on the questions — the equality
      // that identifies "was live when the era ended" for copy-forward and for
      // accepting a straggler recording.
      const claimed = await tx.installation.updateMany({
        where: { id, endedAt: null },
        data: { endedAt },
      });
      if (claimed.count === 0) return null;

      const summary = await closeOutInstallation(tx, id, endedAt);

      return tx.installation.update({
        where: { id },
        data: {
          endedAt,
          endedById: user?.id ?? null,
          summary,
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.location !== undefined ? { location: body.location } : {}),
        },
      });
    }, BULK_TRANSACTION);

    // Lost the claim: another admin ended this era first.
    if (!ended) return c.json({ error: "installation_already_ended" }, 409);

    invalidateActiveInstallationCache();
    // The frozen era's rows just changed underneath every cached aggregate.
    invalidateStatsCaches();
    const dto = serializeInstallation(ended);
    wsBroadcaster.broadcast({ kind: "installation", installation: dto });
    log.info({ installationId: id }, "installation ended");
    recordAudit(c, {
      action: "installation.end",
      targetType: "installation",
      targetId: id,
      metadata: { name: ended.name },
    });
    return c.json(dto);
  },
);

// Download the archive for a single installation without ending it.
installationsRouter.get(
  "/:id/export",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const existing = await db.installation.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "installation_not_found" }, 404);

    const { archive, manifest } = await buildExportArchive({ installationId: id });
    const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
    return c.body(archive as unknown as ArrayBuffer, 200, {
      "content-type": "application/x-tar",
      "content-disposition": `attachment; filename="installation-${id}-${stamp}.tar"`,
      "content-length": String(archive.byteLength),
    });
  },
);

// -----------------------------------------------------------------------------
// Hard purge — irreversible.
// -----------------------------------------------------------------------------

// Delete an ended installation and all of its data, including audio blobs that
// nothing else references. Refuses the active installation outright, and
// requires the caller to echo the exact name back as a speed bump.
installationsRouter.delete(
  "/:id",
  requireAdmin(),
  zValidator("param", idParamSchema),
  zValidator("json", InstallationPurgeSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { confirmName } = c.req.valid("json");

    const existing = await db.installation.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "installation_not_found" }, 404);
    if (!existing.endedAt) return c.json({ error: "installation_active" }, 409);
    if (confirmName !== existing.name) return c.json({ error: "name_mismatch" }, 400);

    // The rollover deliberately leaves `uploading` rows behind: the recording
    // is still in flight, and `/messages/:id/complete` files the finished
    // audio into whichever era is open by then. Deleting one here would make
    // that completion call 404 and lose the recording, so re-home them first.
    // With nothing open there is nowhere to put them, and the purge waits.
    const inFlight = await db.message.findMany({
      where: { installationId: id, status: "uploading" },
      select: { id: true },
    });
    if (inFlight.length > 0) {
      const open = await findActiveInstallation();
      if (!open) return c.json({ error: "uploads_in_flight" }, 409);
      await db.message.updateMany({
        where: { id: { in: inFlight.map((row) => row.id) } },
        data: { installationId: open.id },
      });
    }

    // Candidate blobs are resolved before the delete so we still know which
    // files belonged to this era once the rows are gone.
    const ownedFiles = await filesOwnedByInstallation(id);

    const rows = await db.$transaction(async (tx) => {
      const where = { installationId: id };
      // Children first: transcriptions/moderations cascade from Message, but
      // events reference sessions, so clear events before sessions.
      const events = await tx.boothEvent.deleteMany({ where });
      const messages = await tx.message.deleteMany({ where });
      const sessions = await tx.callSession.deleteMany({ where });
      const questions = await tx.question.deleteMany({ where });
      const snapshots = await tx.boothStatusSnapshot.deleteMany({ where });
      await tx.installation.delete({ where: { id } });
      return {
        events: events.count,
        messages: messages.count,
        callSessions: sessions.count,
        questions: questions.count,
        snapshots: snapshots.count,
      };
    }, BULK_TRANSACTION);

    // A File row is shared: a question copied forward into a later era points
    // at the same row as the original. So a file is only orphaned once nothing
    // references it any more — that check is what stops a purge from silently
    // muting a live booth.
    invalidateStatsCaches();

    const result = await purgeOrphanFiles(ownedFiles);

    log.warn({ installationId: id, rows, ...result }, "installation purged");
    const body: InstallationPurgeResult = { installationId: id, rows, ...result };
    // The rows this destroyed are gone for good, so the trail is the only
    // record left that it happened at all.
    recordAudit(c, {
      action: "installation.purge",
      targetType: "installation",
      targetId: id,
      metadata: { name: existing.name, rows, blobsDeleted: result.blobsDeleted },
    });
    return c.json(body);
  },
);

type OwnedFile = { id: string; blobKey: string };

const filesOwnedByInstallation = async (installationId: string): Promise<OwnedFile[]> => {
  const [questionFiles, messageFiles] = await Promise.all([
    db.question.findMany({
      where: { installationId },
      select: { audio: { select: { id: true, blobKey: true } } },
    }),
    db.message.findMany({
      where: { installationId },
      select: { audio: { select: { id: true, blobKey: true } } },
    }),
  ]);
  const byId = new Map<string, OwnedFile>();
  for (const row of [...questionFiles, ...messageFiles]) {
    if (row.audio) byId.set(row.audio.id, row.audio);
  }
  return [...byId.values()];
};

const purgeOrphanFiles = async (
  owned: OwnedFile[],
): Promise<{ blobsDeleted: number; blobsRetained: number; blobFailures: string[] }> => {
  if (owned.length === 0) return { blobsDeleted: 0, blobsRetained: 0, blobFailures: [] };

  const ids = owned.map((file) => file.id);

  // The era's own rows are already gone, so anything still pointing at these
  // files belongs to another era (a question copied forward) or to an
  // installation-independent instruction. `Question.audioId` is `ON DELETE
  // RESTRICT`, so deleting a file that is still referenced would error anyway.
  const [questions, messages, instructions] = await Promise.all([
    db.question.findMany({ where: { audioId: { in: ids } }, select: { audioId: true } }),
    db.message.findMany({ where: { audioId: { in: ids } }, select: { audioId: true } }),
    db.instruction.findMany({ where: { audioId: { in: ids } }, select: { audioId: true } }),
  ]);
  const referenced = new Set([
    ...questions.map((row) => row.audioId),
    ...messages.map((row) => row.audioId),
    ...instructions.map((row) => row.audioId),
  ]);

  const orphans = owned.filter((file) => !referenced.has(file.id));
  // A booth upload can adopt one of these content-addressed rows between the
  // reference check above and this delete — the SHA is shared, so the new
  // recording reuses the very file the purge just decided was unreferenced. In
  // that case the batch delete fails on the foreign key, so fall back to
  // deleting one at a time and simply retain whichever row was claimed. The
  // era's own rows are already gone; failing the whole purge (or worse,
  // deleting a blob a live message now points at) would be the wrong trade.
  const deleted: OwnedFile[] = [];
  if (orphans.length > 0) {
    try {
      await db.file.deleteMany({ where: { id: { in: orphans.map((file) => file.id) } } });
      deleted.push(...orphans);
    } catch (error) {
      log.warn({ err: error }, "orphan file delete failed as a batch; retrying one at a time");
      for (const file of orphans) {
        try {
          await db.file.delete({ where: { id: file.id } });
          deleted.push(file);
        } catch (err) {
          log.warn({ err, fileId: file.id }, "retaining file claimed during purge");
        }
      }
    }
  }
  const blobsRetained = owned.length - deleted.length;

  let blobsDeleted = 0;
  let blobsResurrected = 0;
  const blobFailures: string[] = [];

  // Blob deletion runs after the database transaction has committed. A partial
  // failure leaves an orphaned blob, which is wasteful but harmless, so we
  // report it rather than rolling back a delete that already succeeded.
  //
  // A long installation can hold thousands of recordings, and one round trip at
  // a time would put the request in reach of a proxy timeout. A small pool
  // keeps it bounded without hammering the storage account.
  const queue = [...deleted];
  const worker = async (): Promise<void> => {
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const { blobKey } = next;
      try {
        // Recordings are content-addressed, so a booth upload after the row
        // above was deleted can recreate the same file and blob key while this
        // pool is still working through the queue. Re-check immediately before
        // each delete and leave a resurrected blob alone: deleting it would
        // take the audio out from under a live message.
        if (await db.file.findFirst({ where: { blobKey }, select: { id: true } })) {
          blobsResurrected += 1;
          continue;
        }
        // `deleteBlob` reports false when the blob was already gone. Counting
        // that as a deletion would overstate what the purge actually removed.
        if (await deleteBlob(blobKey)) blobsDeleted += 1;
      } catch (error) {
        log.error({ err: error, blobKey }, "failed to delete blob during purge");
        blobFailures.push(blobKey);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PURGE_BLOB_CONCURRENCY, queue.length) }, () => worker()),
  );

  return { blobsDeleted, blobsRetained: blobsRetained + blobsResurrected, blobFailures };
};
