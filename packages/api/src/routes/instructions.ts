import { zValidator } from "@hono/zod-validator";
import { InstructionCreateSchema, InstructionStatusSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { serializeInstruction } from "../lib/serializers.js";
import { requireAdmin, type AuthVariables } from "../lib/session.js";

const listQuerySchema = z.object({
  cursor: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: InstructionStatusSchema.optional(),
});

const idParamSchema = z.object({ id: z.guid() });

export const instructionsRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

instructionsRouter.get("/current", requireApiToken(), async (c) => {
  const instruction = await db.instruction.findFirst({
    where: { status: "active" },
    include: { audio: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!instruction) return c.json({ error: "no_instructions_available" }, 404);
  return c.json(serializeInstruction(instruction));
});

instructionsRouter.get("/", requireAdmin(), zValidator("query", listQuerySchema), async (c) => {
  const { cursor, limit, status } = c.req.valid("query");
  const where = status ? { status } : {};
  const instructions = await db.instruction.findMany({
    where,
    include: { audio: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = instructions.slice(0, limit).map(serializeInstruction);
  const next = instructions.length > limit ? instructions[limit]?.id : null;
  return c.json({ items, nextCursor: next ?? null });
});

instructionsRouter.post(
  "/",
  requireAdmin(),
  zValidator("json", InstructionCreateSchema),
  async (c) => {
    const body = c.req.valid("json");
    const audio = await db.file.findUnique({ where: { id: body.audioFileId } });
    if (!audio) return c.json({ error: "audio_file_not_found" }, 404);

    try {
      const instruction = await db.instruction.create({
        data: {
          description: body.description ?? null,
          audioId: body.audioFileId,
          status: body.status ?? "active",
        },
        include: { audio: true },
      });
      return c.json(serializeInstruction(instruction), 201);
    } catch {
      return c.json({ error: "instruction_conflict" }, 409);
    }
  },
);

instructionsRouter.post(
  "/:id/activate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const instruction = await db.instruction.findUnique({ where: { id } });
    if (!instruction) return c.json({ error: "not_found" }, 404);

    const updated = await db.instruction.update({
      where: { id },
      data: { status: "active" },
      include: { audio: true },
    });
    return c.json(serializeInstruction(updated));
  },
);

instructionsRouter.post(
  "/:id/deactivate",
  requireAdmin(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const instruction = await db.instruction.findUnique({ where: { id } });
    if (!instruction) return c.json({ error: "not_found" }, 404);

    const updated = await db.instruction.update({
      where: { id },
      data: { status: "inactive" },
      include: { audio: true },
    });
    return c.json(serializeInstruction(updated));
  },
);

instructionsRouter.delete("/:id", requireAdmin(), zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const instruction = await db.instruction.findUnique({ where: { id } });
  if (!instruction) return c.json({ error: "not_found" }, 404);

  await db.instruction.delete({ where: { id } });
  return c.body(null, 204);
});
