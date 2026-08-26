import { randomInt } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  InstallationScopeSchema,
  QUESTION_WEIGHT_MAX,
  QUESTION_WEIGHT_MIN,
  QuestionCreateSchema,
  QuestionStatusSchema,
  QuestionUpdateSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { Prisma, type File, type Question } from "../generated/prisma/client.js";
import { recordAudit } from "../lib/audit.js";
import { db } from "../lib/db.js";
import {
  lockInstallationForWrite,
  lockOpenInstallationExclusively,
  NoOpenEraError,
  runWithOpenEra,
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
const questionDrawIdSchema = z.guid();
const QUESTION_DRAW_ID_HEADER = "x-question-draw-id";
const QUESTION_DRAW_HISTORY_LIMIT = 100;
const questionDrawHistorySchema = z.array(
  z.object({
    drawId: z.guid(),
    questionId: z.guid(),
  }),
);
const QUESTION_DRAW_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 1_000,
  timeout: 5_000,
} as const;

// No era is open and one could not be resolved. Distinct from a conflict: the
// caller's request was fine, the installation bookkeeping was not.

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
  recordAudit(c, {
    action: "question.create",
    targetType: "question",
    metadata: { prompt: body.prompt, status: body.status ?? "draft" },
  });
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
    const question = await runWithOpenEra(preferredEra, async (tx, era) => {
      return tx.question.create({
        data: {
          prompt: body.prompt,
          audioId: body.audioFileId,
          status: body.status ?? "draft",
          weight: body.weight ?? 1,
          installationId: era,
        },
        include: { audio: true },
      });
    });
    recordAudit(c, { targetId: question.id });
    return c.json(serializeQuestion(question), 201);
  } catch (err) {
    // Every era ending underneath the retry: bookkeeping is in a state the
    // operator has to resolve, not something to report as a conflict.
    if (err instanceof NoOpenEraError) return c.json({ error: "no_open_installation" }, 503);
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
class QuestionArchivedError extends Error {}

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

questionsRouter.patch(
  "/:id",
  requireAdmin(),
  zValidator("param", idParamSchema),
  zValidator("json", QuestionUpdateSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    recordAudit(c, {
      action: "question.update",
      targetType: "question",
      targetId: id,
      metadata: { fields: Object.keys(body) },
    });
    const question = await db.question.findUnique({ where: { id } });
    if (!question || question.status === "archived") return c.json({ error: "not_found" }, 404);

    try {
      const updated = await withOpenEra(question.installationId, async (tx) => {
        const result = await tx.question.updateMany({
          where: { id, status: { not: "archived" } },
          data: {
            ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
            ...(body.weight !== undefined ? { weight: body.weight } : {}),
          },
        });
        if (result.count === 0) throw new QuestionArchivedError();
        const current = await tx.question.findUnique({
          where: { id },
          include: { audio: true },
        });
        if (!current) throw new QuestionArchivedError();
        return current;
      });
      return c.json(serializeQuestion(updated));
    } catch (error) {
      if (error instanceof QuestionArchivedError) return c.json({ error: "not_found" }, 404);
      if (error instanceof InstallationEndedError) return c.json(endedEraResponse, 409);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return c.json({ error: "question_conflict" }, 409);
      }
      throw error;
    }
  },
);

questionsRouter.post(
  "/:id/activate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    recordAudit(c, { action: "question.activate", targetType: "question", targetId: id });
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
    recordAudit(c, { action: "question.deactivate", targetType: "question", targetId: id });
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
  recordAudit(c, { action: "question.archive", targetType: "question", targetId: id });
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

type QuestionTicketState = {
  id: string;
  weight: number;
  lastSelectedCycle: number | null;
  selectionsInCycle: number;
};

const remainingTickets = (question: QuestionTicketState, cycle: number): number => {
  const consumed = question.lastSelectedCycle === cycle ? question.selectionsInCycle : 0;
  return Math.max(0, question.weight - consumed);
};

const drawQuestion = (
  questions: QuestionTicketState[],
  cycle: number,
  lastSelectedQuestionId: string | null,
): QuestionTicketState | null => {
  const available = questions
    .map((question) => ({ question, tickets: remainingTickets(question, cycle) }))
    .filter(({ tickets }) => tickets > 0);
  const alternatives = available.filter(({ question }) => question.id !== lastSelectedQuestionId);
  const pool = alternatives.length > 0 ? alternatives : available;
  const totalTickets = pool.reduce((total, entry) => total + entry.tickets, 0);
  if (totalTickets === 0) return null;

  let ticket = randomInt(totalTickets);
  for (const entry of pool) {
    if (ticket < entry.tickets) return entry.question;
    ticket -= entry.tickets;
  }
  throw new Error("question ticket draw exceeded the available pool");
};

const containsPostgresCode = (value: unknown, expected: string): boolean => {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsPostgresCode(item, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsPostgresCode(item, expected));
};

const isQuestionDrawContention = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2028") return true;
    if (error.code === "P2010" && containsPostgresCode(error.meta, "55P03")) return true;
  }
  return error instanceof Error && /55P03|lock timeout/iu.test(error.message);
};

questionsRouter.get("/random", requireApiToken(), async (c) => {
  c.header("Cache-Control", "no-store");
  const rawDrawId = c.req.header(QUESTION_DRAW_ID_HEADER);
  const parsedDrawId =
    rawDrawId === undefined ? undefined : questionDrawIdSchema.safeParse(rawDrawId);
  if (parsedDrawId !== undefined && !parsedDrawId.success) {
    return c.json({ error: "invalid_question_draw_id" }, 400);
  }
  const drawId = parsedDrawId?.data.toLowerCase();

  let question: (Question & { audio: File }) | null;
  try {
    question = await db.$transaction(async (tx) => {
      // Bound row-lock waits below the phone's request timeout. A rollover may
      // legitimately hold this lock for minutes, so callers get a retriable
      // response instead of an ambiguous interactive-transaction timeout.
      await tx.$queryRaw`SELECT set_config('lock_timeout', '3000ms', true)`;

      // A draw is a write to the installation's durable ticket bag. Locking the
      // era makes concurrent replicas consume distinct tickets.
      const installationId = await lockOpenInstallationExclusively(tx);
      if (installationId === null) return null;

      const installation = await tx.installation.findUnique({
        where: { id: installationId },
        select: {
          questionSelectionCycle: true,
          lastSelectedQuestionId: true,
          recentQuestionDraws: true,
        },
      });
      if (!installation) throw new Error("locked installation disappeared during question draw");
      const recentQuestionDraws = questionDrawHistorySchema.parse(installation.recentQuestionDraws);
      const previousDraw = recentQuestionDraws.find((entry) => entry.drawId === drawId);
      if (previousDraw !== undefined) {
        const replay = await tx.question.findUnique({
          where: { id: previousDraw.questionId },
          include: { audio: true },
        });
        if (!replay) throw new Error("selected question disappeared before draw replay");
        return replay;
      }

      const activeQuestions = await tx.question.findMany({
        where: { installationId, status: "active" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          weight: true,
          lastSelectedCycle: true,
          selectionsInCycle: true,
        },
      });
      if (activeQuestions.length === 0) return null;
      const invalidWeight = activeQuestions.find(
        (question) =>
          !Number.isInteger(question.weight) ||
          question.weight < QUESTION_WEIGHT_MIN ||
          question.weight > QUESTION_WEIGHT_MAX,
      );
      if (invalidWeight) {
        throw new Error(`question ${invalidWeight.id} has invalid selection weight`);
      }

      let cycle = installation.questionSelectionCycle;
      let selected = drawQuestion(activeQuestions, cycle, installation.lastSelectedQuestionId);
      if (selected === null) {
        cycle += 1;
        selected = drawQuestion(activeQuestions, cycle, installation.lastSelectedQuestionId);
      }
      if (selected === null) {
        throw new Error("active questions have no valid selection tickets");
      }

      const selectionsInCycle =
        selected.lastSelectedCycle === cycle ? selected.selectionsInCycle + 1 : 1;
      const nextQuestionDraws =
        drawId === undefined
          ? recentQuestionDraws
          : [
              ...recentQuestionDraws.filter((entry) => entry.drawId !== drawId),
              { drawId, questionId: selected.id },
            ].slice(-QUESTION_DRAW_HISTORY_LIMIT);
      await tx.installation.update({
        where: { id: installationId },
        data: {
          questionSelectionCycle: cycle,
          lastSelectedQuestionId: selected.id,
          recentQuestionDraws: nextQuestionDraws,
        },
      });
      return tx.question.update({
        where: { id: selected.id },
        data: {
          lastSelectedCycle: cycle,
          selectionsInCycle,
        },
        include: { audio: true },
      });
    }, QUESTION_DRAW_TRANSACTION);
  } catch (error) {
    if (!isQuestionDrawContention(error)) throw error;
    c.header("Retry-After", "1");
    return c.json({ error: "question_draw_busy" }, 503);
  }
  if (!question) return c.json({ error: "no_questions_available" }, 404);
  return c.json(serializeQuestion(question));
});
