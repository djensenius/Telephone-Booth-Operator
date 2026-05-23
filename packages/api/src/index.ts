/**
 * Operator API entrypoint.
 *
 * Wires up Hono routes, OIDC auth middleware, and the status WebSocket.
 * The concrete route handlers live under `src/routes/`, the auth middleware
 * under `src/lib/auth.ts`, and the WebSocket fan-out under `src/ws/status.ts`.
 *
 * This file intentionally stays thin — see `docs/architecture.md`.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";

const app = new Hono();

app.use("*", logger());

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    version: process.env.npm_package_version ?? "0.0.0",
    time: new Date().toISOString(),
  }),
);

const port = Number.parseInt(process.env.API_PORT ?? "8787", 10);
serve({ fetch: app.fetch, port }, ({ port }) => {
  // eslint-disable-next-line no-console
  console.log(`telephone-booth-operator API listening on :${port}`);
});

export { app };
