/**
 * Operator API entrypoint.
 *
 * Wires up Hono routes, OIDC auth middleware, and the status WebSocket.
 * The concrete route handlers live under `src/routes/`, the auth middleware
 * under `src/lib/session.ts`, and the WebSocket fan-out under `src/ws/status.ts`.
 *
 * This file intentionally stays thin — see `docs/architecture.md`.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { pathToFileURL } from "node:url";
import { startAiSweeper } from "./lib/ai/sweeper.js";
import { apnsHealthStatus, logApnsConfiguration } from "./lib/apns.js";
import { auditWrites, type AuditVariables } from "./lib/audit.js";
import { startAuditPruner } from "./lib/audit-pruner.js";
import { startSnapshotPruner } from "./lib/snapshot-pruner.js";
import {
  AuthConfigurationError,
  assertAuthorizationConfigured,
  assertOidcIssuerAllowed,
  resolveAuthConfig,
} from "./lib/config.js";
import { requireOperator, type AuthVariables } from "./lib/session.js";
import apiTokensRouter from "./routes/api-tokens.js";
import { adminDataRouter } from "./routes/admin-data.js";
import { auditRouter } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { devicesRouter } from "./routes/devices.js";
import { eventsRouter } from "./routes/events.js";
import { installationsRouter } from "./routes/installations.js";
import { instructionsRouter } from "./routes/instructions.js";
import { messagesRouter } from "./routes/messages.js";
import { messageProcessingRouter } from "./routes/message-processing.js";
import { monitorRouter } from "./routes/monitor.js";
import { questionsRouter } from "./routes/questions.js";
import { sessionsRouter } from "./routes/sessions.js";
import { statsRouter } from "./routes/stats.js";
import { statusRouter } from "./routes/status.js";
import { componentTelemetryRouter } from "./routes/system-components.js";
import { systemRouter } from "./routes/system.js";
import { uploadsRouter } from "./routes/uploads.js";
import { workerRouter } from "./routes/worker.js";
import { attachStatusWebSocket, wsRouter } from "./routes/ws.js";

const webOrigins = (): string[] =>
  (process.env.WEB_ORIGIN ?? process.env.PUBLIC_WEB_URL ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const createApp = (): Hono<{ Variables: AuthVariables & AuditVariables }> => {
  const app = new Hono<{ Variables: AuthVariables & AuditVariables }>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      credentials: true,
      origin: (origin) => (webOrigins().includes(origin) ? origin : ""),
    }),
  );
  // Mounted before every auth guard so rejected writes are audited too.
  app.use("/v1/*", auditWrites());

  app.get("/healthz", async (c) =>
    c.json({
      status: "ok",
      version: process.env.npm_package_version ?? "0.0.0",
      time: new Date().toISOString(),
      apns: await apnsHealthStatus(),
    }),
  );

  app.route("/v1/auth", authRoutes);
  app.route("/v1/api-tokens", apiTokensRouter);
  // /v1/worker is the push-mode result-callback surface for the Transcription
  // app (macOS + iOS). It authenticates with a static API token via
  // `requireApiToken` (applied inside the router) so it must be mounted BEFORE
  // the operator-session middleware that guards the rest of /v1/*. This
  // replaced the removed `/v1/jobs` pull queue.
  app.route("/v1/worker", workerRouter);
  app.use("/v1/*", requireOperator());

  // Operator backend resource routes. Keep token-management mounts separate;
  // the operator-token-mgmt sibling task owns /v1/api-tokens.
  app.route("/v1/questions", questionsRouter);
  app.route("/v1/installations", installationsRouter);
  app.route("/v1/instructions", instructionsRouter);
  app.route("/v1/messages", messagesRouter);
  app.route("/v1/message-processing", messageProcessingRouter);
  app.route("/v1/monitor", monitorRouter);
  app.route("/v1/status", statusRouter);
  app.route("/v1/events", eventsRouter);
  app.route("/v1/sessions", sessionsRouter);
  app.route("/v1/stats", statsRouter);
  app.route("/v1/system", systemRouter);
  app.route("/v1/system/components", componentTelemetryRouter);
  app.route("/v1/uploads", uploadsRouter);
  app.route("/v1/devices", devicesRouter);
  app.route("/v1/admin/data", adminDataRouter);
  app.route("/v1/audit-logs", auditRouter);
  app.route("/v1/ws", wsRouter);

  return app;
};

const start = async (): Promise<void> => {
  try {
    const authConfig = resolveAuthConfig();
    if (authConfig.disabled && process.env.NODE_ENV === "production") {
      throw new AuthConfigurationError("AUTH_DISABLED=true is not allowed in production.");
    }
    assertOidcIssuerAllowed(authConfig);
    assertAuthorizationConfigured(authConfig);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid auth configuration.");
    process.exitCode = 1;
    return;
  }

  const port = Number.parseInt(process.env.API_PORT ?? "8787", 10);
  await logApnsConfiguration();
  const server = serve({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`telephone-booth-operator API listening on :${port}`);
  });
  const statusWebSocket = attachStatusWebSocket(server);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void statusWebSocket.close().finally(() => {
      const forceClose = setTimeout(() => {
        if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      }, 10_000);
      forceClose.unref();
      server.close(() => {
        clearTimeout(forceClose);
      });
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.once("close", () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  });
  startAiSweeper();
  startSnapshotPruner();
  startAuditPruner();
};

const app = createApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start();
}

export { app };
