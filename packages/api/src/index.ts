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
import { AuthConfigurationError, resolveAuthConfig } from "./lib/config.js";
import { requireOperator, type AuthVariables } from "./lib/session.js";
import apiTokensRouter from "./routes/api-tokens.js";
import { authRoutes } from "./routes/auth.js";
import { eventsRouter } from "./routes/events.js";
import { messagesRouter } from "./routes/messages.js";
import { questionsRouter } from "./routes/questions.js";
import { sessionsRouter } from "./routes/sessions.js";
import { statsRouter } from "./routes/stats.js";
import { statusRouter } from "./routes/status.js";
import { systemRouter } from "./routes/system.js";
import { uploadsRouter } from "./routes/uploads.js";
import { attachStatusWebSocket, wsRouter } from "./routes/ws.js";

const webOrigins = (): string[] =>
  (process.env.WEB_ORIGIN ?? process.env.PUBLIC_WEB_URL ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const createApp = (): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      credentials: true,
      origin: (origin) => (webOrigins().includes(origin) ? origin : ""),
    }),
  );

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      version: process.env.npm_package_version ?? "0.0.0",
      time: new Date().toISOString(),
    }),
  );

  app.route("/v1/auth", authRoutes);
  app.route("/v1/api-tokens", apiTokensRouter);
  app.use("/v1/*", requireOperator());

  // Operator backend resource routes. Keep token-management mounts separate;
  // the operator-token-mgmt sibling task owns /v1/api-tokens.
  app.route("/v1/questions", questionsRouter);
  app.route("/v1/messages", messagesRouter);
  app.route("/v1/status", statusRouter);
  app.route("/v1/events", eventsRouter);
  app.route("/v1/sessions", sessionsRouter);
  app.route("/v1/stats", statsRouter);
  app.route("/v1/system", systemRouter);
  app.route("/v1/uploads", uploadsRouter);
  app.route("/v1/ws", wsRouter);

  return app;
};

const start = (): void => {
  try {
    const authConfig = resolveAuthConfig();
    if (authConfig.disabled && process.env.NODE_ENV === "production") {
      throw new AuthConfigurationError("AUTH_DISABLED=true is not allowed in production.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid auth configuration.");
    process.exitCode = 1;
    return;
  }

  const port = Number.parseInt(process.env.API_PORT ?? "8787", 10);
  const server = serve({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`telephone-booth-operator API listening on :${port}`);
  });
  attachStatusWebSocket(server);
  startAiSweeper();
};

const app = createApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}

export { app };
