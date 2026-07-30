import { zValidator } from "@hono/zod-validator";
import {
  InstallationScopeSchema,
  QuestionCreateSchema,
  QuestionStatusSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { db } from "../lib/db.js";
import {
  lockInstallationForWrite,
  lockOpenInstallation,
  requireActiveInstallation,
  resolveInstallationScope,
  scopeWhere,
} from "../lib/installation.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { serializeQuestion } from "../lib/serializers.js";
import { requireAdmin, type AuthVariables } from "../lib/session.js";

const listQuerySchema = z.object({
  cursor: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // `any` includes archived questions; the bare default hides them.
  status: z.union([QuestionStatusSchema, z.literal("any")]).optional(),
  installationId: InstallationScopeSchema.optional(),
  // Comma-separated ids. Resolves exactly the questions a caller already knows
  // about — the prompts on a page of messages, say — regardless of era or
  // status, which neither the scope nor a page of results can guarantee.
  ids: z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(",").filter((id) => id.length > 0) : undefined))
    .pipe(z.array(z.guid()).max(200).optional()),
});

const idParamSchema = z.object({ id: z.guid() });

// No era is open and one could not be resolved. Distinct from a conflict: the
// caller's request was fine, the installation bookkeeping was not.
class EraUnavailableError extends Error {}

export const questionsRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

questionsRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { cursor, limit, status, installationId, ids } = c.req.valid("query");
  // Default management view hides archived questions but shows drafts; an
  // explicit status filter overrides this, and `any` drops the filter so a
  // caller resolving prompts for historical messages can still find them.
  // An explicit id list is the whole filter: it already names the rows, and
  // narrowing it by era or status would defeat the point of asking.
  const where = ids
    ? { id: { in: ids } }
    : {
        ...scopeWhere(await resolveInstallationScope(installationId)),
        ...(status === "any" ? {} : status ? { status } : { status: { not: "archived" as const } }),
      };
  // An id list is already bounded by the schema at 200, and a caller resolving
  // named rows cannot page: it asked for these questions, not for a window over
  // them. Paginating here would silently drop the tail of a long list.
  const page = ids
    ? { take: ids.length }
    : { take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
  const questions = await db.question.findMany({
    where,
    include: { audio: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...page,
  });
  if (ids) return c.json({ items: questions.map(serializeQuestion), nextCursor: null });
  const items = questions.slice(0, limit).map(serializeQuestion);
  const next = questions.length > limit ? questions[limit]?.id : null;
  return c.json({ items, nextCursor: next ?? null });
});

questionsRouter.post("/", requireAdmin(), zValidator("json", QuestionCreateSchema), async (c) => {
  const body = c.req.valid("json");
  const audio = await db.file.findUnique({ where: { id: body.audioFileId } });
  if (!audio) return c.json({ error: "audio_file_not_found" }, 404);

  // A prompt must not land in an era that is being closed out: the close-out
  // retires the questions it can see, and one inserted behind its back would
  // stay live inside a frozen era. Holding the era row shared for the length of
  // the insert makes the two queue instead of overlapping — unlike a booth
  // recording, an admin write has no reason to accept that race.
  try {
    // Resolved before the transaction: this is the call that lazily opens an
    // era on a fresh database, and it must not run while holding a pooled
    // connection of its own.
    const preferredEra = await requireActiveInstallation();
    const question = await db.$transaction(async (tx) => {
      const era = await lockOpenInstallation(tx, preferredEra);
      if (!era) throw new EraUnavailableError();
      return tx.question.create({
        data: {
          prompt: body.prompt,
          audioId: body.audioFileId,
          status: body.status ?? "draft",
          installationId: era,
        },
        include: { audio: true },
      });
    });
    return c.json(serializeQuestion(question), 201);
  } catch (err) {
    if (err instanceof EraUnavailableError) return c.json({ error: "no_open_installation" }, 503);
    // Only a genuine uniqueness collision is the caller's problem. Anything
    // else is ours, and reporting it as a conflict would send the operator
    // round a retry loop that cannot succeed.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return c.json({ error: "question_conflict" }, 409);
    }
    throw err;
  }
});

// A prompt belongs to an era. Once that era has ended its questions were
// archived with `retiredAt = endedAt`, which is what identifies them as having
// been live at the end — and what a straggler recording is matched against. So
// its lifecycle is closed too: activating, deactivating or archiving one would
// either overwrite that marker or put a live prompt inside a frozen era. The
// era row is held shared for the write, so a rollover cannot commit between
// the check and the change.
class InstallationEndedError extends Error {}

const withOpenEra = async <T>(
  installationId: string | null,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  db.$transaction(async (tx) => {
    if (installationId !== null && !(await lockInstallationForWrite(tx, installationId))) {
      throw new InstallationEndedError();
    }
    return write(tx);
  });

const endedEraResponse = { error: "installation_ended" } as const;

questionsRouter.post(
  "/:id/activate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const question = await db.question.findUnique({ where: { id } });
    if (!question) return c.json({ error: "not_found" }, 404);

    try {
      const updated = await withOpenEra(question.installationId, (tx) =>
        tx.question.update({
          where: { id },
          data: { status: "active", retiredAt: null },
          include: { audio: true },
        }),
      );
      return c.json(serializeQuestion(updated));
    } catch (error) {
      if (error instanceof InstallationEndedError) return c.json(endedEraResponse, 409);
      throw error;
    }
  },
);

questionsRouter.post(
  "/:id/deactivate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const question = await db.question.findUnique({ where: { id } });
    if (!question) return c.json({ error: "not_found" }, 404);

    try {
      const updated = await withOpenEra(question.installationId, (tx) =>
        tx.question.update({
          where: { id },
          data: { status: "draft", retiredAt: null },
          include: { audio: true },
        }),
      );
      return c.json(serializeQuestion(updated));
    } catch (error) {
      if (error instanceof InstallationEndedError) return c.json(endedEraResponse, 409);
      throw error;
    }
  },
);

questionsRouter.delete("/:id", requireAdmin(), zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const question = await db.question.findUnique({ where: { id } });
  if (!question || question.status === "archived") return c.json({ error: "not_found" }, 404);

  try {
    await withOpenEra(question.installationId, (tx) =>
      tx.question.update({
        where: { id },
        data: { status: "archived", retiredAt: new Date() },
      }),
    );
  } catch (error) {
    if (error instanceof InstallationEndedError) return c.json(endedEraResponse, 409);
    throw error;
  }
  return c.body(null, 204);
});

questionsRouter.get("/random", requireApiToken(), async (c) => {
  // The booth only ever plays questions from the installation it is currently
  // part of; ending an era archives its questions, but scoping here keeps that
  // true even if one is un-archived after the fact.
  // Resolved as a read, not a write: a poll that arrives between an era
  // ending and the booth's next event must answer "nothing to play" rather
  // than open an era of its own.
  const where = {
    status: "active" as const,
    ...scopeWhere(await resolveInstallationScope(undefined)),
  };
  const count = await db.question.count({ where });
  if (count === 0) return c.json({ error: "no_questions_available" }, 404);

  const skip = Math.floor(Math.random() * count);
  const question = await db.question.findFirst({
    where,
    include: { audio: true },
    orderBy: { id: "asc" },
    skip,
  });
  if (!question) return c.json({ error: "no_questions_available" }, 404);
  return c.json(serializeQuestion(question));
});
