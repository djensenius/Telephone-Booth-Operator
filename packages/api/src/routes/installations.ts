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
import { deleteBlob } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { buildExportArchive } from "../lib/data-archive.js";
import { db } from "../lib/db.js";
import {
  computeInstallationSummary,
  findActiveInstallation,
  invalidateActiveInstallationCache,
  nextInstallationName,
  serializeInstallation,
} from "../lib/installation.js";
import { log } from "../lib/logger.js";
import { requireAdmin, requireOperator, type AuthVariables } from "../lib/session.js";

export const installationsRouter = new Hono<{ Variables: AuthVariables }>();

const idParamSchema = z.object({ id: z.guid() });

// Outcome stamped on call sessions still open when the era is closed, so they
// are distinguishable from sessions the booth ended itself.
const ROLLOVER_OUTCOME = "installation_ended";

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

// Start a new installation. The previous one must already be ended — the
// partial unique index guarantees this, but we check first so the caller gets
// a useful 409 rather than a constraint error.
//
// One wrinkle: a booth that is powered on keeps posting events, and a write
// with no active installation lazily creates one (a booth must never fail to
// record a call over admin bookkeeping). So between the operator ending an era
// and naming the next one, the booth can quietly open an unnamed era. Rather
// than making the operator fight that race, an active era with no activity in
// it yet is *adopted*: named, described, and used as the new era.
installationsRouter.post(
  "/",
  requireAdmin(),
  zValidator("json", InstallationCreateSchema),
  async (c) => {
    const body = c.req.valid("json");
    const active = await findActiveInstallation();
    if (active && (await hasActivity(active.id))) {
      return c.json({ error: "installation_already_active", installationId: active.id }, 409);
    }

    // Questions carry forward from the last era that was actually closed, not
    // from an empty one we are about to adopt.
    const previous = await db.installation.findFirst({
      where: { endedAt: { not: null } },
      orderBy: [{ endedAt: "desc" }],
    });

    const created = await db.$transaction(async (tx) => {
      const data = {
        name: body.name.length > 0 ? body.name : await nextInstallationName(),
        notes: body.notes ?? null,
        location: body.location ?? null,
      };
      const installation = active
        ? await tx.installation.update({
            where: { id: active.id },
            data: { ...data, startedAt: new Date() },
          })
        : await tx.installation.create({ data });

      // Copied questions point at the *same* `File` row as the original, so
      // the audio is shared rather than re-uploaded and SHA-256 dedupe is
      // preserved. This is why `Question.audioId` is not unique, and why the
      // purge below refcounts `File` rows before deleting any blob.
      //
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
        for (const question of source) {
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
        }
      }

      return installation;
    });

    invalidateActiveInstallationCache();
    const dto = serializeInstallation(created);
    wsBroadcaster.broadcast({ kind: "installation", installation: dto });
    log.info(
      { installationId: created.id, copyQuestions: body.copyQuestions },
      "installation started",
    );
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
      },
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
      // Close sessions the booth never ended (power cut, crash mid-call).
      await tx.callSession.updateMany({
        where: { installationId: id, endedAt: null },
        data: { endedAt, outcome: ROLLOVER_OUTCOME },
      });

      // Empty the moderation queue so the next era starts clean. The audio and
      // transcripts are untouched and stay visible under this installation's
      // scope; only the queue-visible statuses move to a terminal one.
      await tx.message.updateMany({
        where: { installationId: id, status: { in: ["uploading", "received", "pending"] } },
        data: {
          status: "rejected",
          notes: "Closed out when the installation ended.",
          decidedAt: endedAt,
        },
      });

      // Retire this era's live questions. Drafts are left alone so they stay
      // distinguishable from questions that were actually in rotation.
      await tx.question.updateMany({
        where: { installationId: id, status: "active" },
        data: { status: "archived", retiredAt: endedAt },
      });

      // Computed last, so the frozen counters agree with what browsing this
      // era afterwards reports — in particular the messages the rollover
      // itself just rejected.
      const summary = await computeInstallationSummary(tx, id);

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
    });

    invalidateActiveInstallationCache();
    const dto = serializeInstallation(ended);
    wsBroadcaster.broadcast({ kind: "installation", installation: dto });
    log.info({ installationId: id }, "installation ended");
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
    });

    // A File row is shared: a question copied forward into a later era points
    // at the same row as the original. So a file is only orphaned once nothing
    // references it any more — that check is what stops a purge from silently
    // muting a live booth.
    const result = await purgeOrphanFiles(ownedFiles);

    log.warn({ installationId: id, rows, ...result }, "installation purged");
    const body: InstallationPurgeResult = { installationId: id, rows, ...result };
    return c.json(body);
  },
);

// Whether an installation has recorded anything yet. Used to tell a freshly
// auto-created era (which the operator can safely adopt and name) apart from
// one the booth has actually been running in.
const hasActivity = async (installationId: string): Promise<boolean> => {
  const where = { installationId };
  const [calls, messages, events, snapshots] = await Promise.all([
    db.callSession.count({ where }),
    db.message.count({ where }),
    db.boothEvent.count({ where }),
    db.boothStatusSnapshot.count({ where }),
  ]);
  return calls + messages + events + snapshots > 0;
};

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
  const blobsRetained = owned.length - orphans.length;
  if (orphans.length > 0) {
    await db.file.deleteMany({ where: { id: { in: orphans.map((file) => file.id) } } });
  }

  let blobsDeleted = 0;
  const blobFailures: string[] = [];

  // Blob deletion runs after the database transaction has committed. A partial
  // failure leaves an orphaned blob, which is wasteful but harmless, so we
  // report it rather than rolling back a delete that already succeeded.
  for (const { blobKey } of orphans) {
    try {
      await deleteBlob(blobKey);
      blobsDeleted += 1;
    } catch (error) {
      log.error({ err: error, blobKey }, "failed to delete blob during purge");
      blobFailures.push(blobKey);
    }
  }

  return { blobsDeleted, blobsRetained, blobFailures };
};
