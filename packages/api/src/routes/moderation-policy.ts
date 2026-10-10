import { zValidator } from "@hono/zod-validator";
import { ModerationPolicyUpdateSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import {
  getActiveModerationPolicy,
  updateActiveModerationPolicy,
} from "../lib/ai/moderation-policy.js";
import { recordAudit } from "../lib/audit.js";
import { type AuthVariables, requireAdmin } from "../lib/session.js";

export const moderationPolicyRouter = new Hono<{ Variables: AuthVariables }>();

moderationPolicyRouter.get("/", async (c) => c.json(await getActiveModerationPolicy()));

export const adminModerationPolicyRouter = new Hono<{ Variables: AuthVariables }>();

adminModerationPolicyRouter.get("/", requireAdmin(), async (c) =>
  c.json(await getActiveModerationPolicy()),
);

adminModerationPolicyRouter.put(
  "/",
  requireAdmin(),
  zValidator("json", ModerationPolicyUpdateSchema),
  async (c) => {
    const user = c.get("user");
    const { instructions } = c.req.valid("json");
    const policy = await updateActiveModerationPolicy(instructions, user?.id ?? null);
    recordAudit(c, {
      action: "moderationPolicy.update",
      targetType: "moderationPolicy",
      targetId: policy.key,
      metadata: { version: policy.version },
    });
    return c.json(policy);
  },
);
