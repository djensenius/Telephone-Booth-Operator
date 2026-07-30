import { zValidator } from "@hono/zod-validator";
import {
  InstallationScopeSchema,
  QuestionCreateSchema,
  QuestionStatusSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import {
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
});

const idParamSchema = z.object({ id: z.guid() });

export const questionsRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

questionsRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { cursor, limit, status, installationId } = c.req.valid("query");
  // Default management view hides archived questions but shows drafts; an
  // explicit status filter overrides this, and `any` drops the filter so a
  // caller resolving prompts for historical messages can still find them.
  const where = {
    ...scopeWhere(await resolveInstallationScope(installationId)),
    ...(status === "any" ? {} : status ? { status } : { status: { not: "archived" as const } }),
  };
  const questions = await db.question.findMany({
    where,
    include: { audio: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = questions.slice(0, limit).map(serializeQuestion);
  const next = questions.length > limit ? questions[limit]?.id : null;
  return c.json({ items, nextCursor: next ?? null });
});

questionsRouter.post("/", requireAdmin(), zValidator("json", QuestionCreateSchema), async (c) => {
  const body = c.req.valid("json");
  const audio = await db.file.findUnique({ where: { id: body.audioFileId } });
  if (!audio) return c.json({ error: "audio_file_not_found" }, 404);

  try {
    const question = await db.question.create({
      data: {
        prompt: body.prompt,
        audioId: body.audioFileId,
        status: body.status ?? "draft",
        installationId: await requireActiveInstallation(),
      },
      include: { audio: true },
    });
    return c.json(serializeQuestion(question), 201);
  } catch {
    return c.json({ error: "question_conflict" }, 409);
  }
});

questionsRouter.post(
  "/:id/activate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const question = await db.question.findUnique({ where: { id } });
    if (!question) return c.json({ error: "not_found" }, 404);

    const updated = await db.question.update({
      where: { id },
      data: { status: "active", retiredAt: null },
      include: { audio: true },
    });
    return c.json(serializeQuestion(updated));
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

    const updated = await db.question.update({
      where: { id },
      data: { status: "draft", retiredAt: null },
      include: { audio: true },
    });
    return c.json(serializeQuestion(updated));
  },
);

questionsRouter.delete("/:id", requireAdmin(), zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const question = await db.question.findUnique({ where: { id } });
  if (!question || question.status === "archived") return c.json({ error: "not_found" }, 404);

  await db.question.update({
    where: { id },
    data: { status: "archived", retiredAt: new Date() },
  });
  return c.body(null, 204);
});

questionsRouter.get("/random", requireApiToken(), async (c) => {
  // The booth only ever plays questions from the installation it is currently
  // part of; ending an era archives its questions, but scoping here keeps that
  // true even if one is un-archived after the fact.
  const where = {
    status: "active" as const,
    installationId: await requireActiveInstallation(),
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
