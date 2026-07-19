import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "../lib/api-tokens.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { verifyOperatorBearer } from "../lib/bearer-auth.js";
import {
  readSessionFromCookieHeader,
  sessionIsExpired,
  type AuthVariables,
} from "../lib/session.js";

export const wsRouter = new Hono<{ Variables: AuthVariables }>();

wsRouter.get("/status", (c) => c.json({ error: "upgrade_required" }, 426));

type LiveSocket = WebSocket & { isAlive?: boolean; clientId?: string };

// Per-client outbound backpressure cap. When the buffered amount exceeds
// this, the slow consumer is dropped with code 1009 ("message too big") so
// one stuck client can't pin the whole broadcaster.
const MAX_BUFFERED_BYTES = 1_048_576; // 1 MiB

const isStatusWsPath = (request: IncomingMessage): boolean => {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  return url.pathname === "/v1/ws/status";
};

const closePolicyViolation = (ws: WebSocket): void => {
  ws.close(1008, "operator session required");
};

const bearerTokenFromHeader = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
};

// Authorize a status-socket upgrade. Browser clients present the operator
// session cookie; native operator clients (iOS/watchOS/tvOS, the Rust CLI)
// present an `Authorization: Bearer` Authentik access token; the push-mode
// Transcription worker (macOS + iOS) presents its static Argon2id API token,
// verified the same way as the `/v1/worker` REST callbacks. Any one of these
// grants the read-only status/work stream.
// TODO(security): Static API tokens are currently unscoped. Add worker/operator
// token scopes so phone-client tokens cannot subscribe to worker work events.
const authorizeStatusUpgrade = async (request: IncomingMessage): Promise<boolean> => {
  const session = await readSessionFromCookieHeader(request.headers.cookie);
  if (session && !sessionIsExpired(session)) return true;

  const token = bearerTokenFromHeader(request.headers.authorization);
  if (!token) return false;
  try {
    const result = await verifyOperatorBearer(token);
    if (result.ok) return true;
  } catch {
    // A transient JWKS/network failure must not crash the upgrade handler;
    // fall through to the static API-token check and, failing that, deny.
  }
  try {
    const apiToken = await verifyToken(token);
    return apiToken !== null;
  } catch {
    return false;
  }
};

export const attachStatusWebSocket = (server: ServerType): void => {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<LiveSocket>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  wss.on("connection", (ws: LiveSocket) => {
    ws.isAlive = true;
    ws.clientId = randomUUID();
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => {
      if (ws.clientId) wsBroadcaster.unsubscribe(ws.clientId);
    });
    wsBroadcaster.subscribe(ws.clientId, (envelope) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1009, "operator slow consumer");
        return;
      }
      ws.send(JSON.stringify(envelope));
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isStatusWsPath(request)) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      void (async () => {
        if (!(await authorizeStatusUpgrade(request))) {
          closePolicyViolation(ws);
          return;
        }
        wss.emit("connection", ws, request);
      })();
    });
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });
};
