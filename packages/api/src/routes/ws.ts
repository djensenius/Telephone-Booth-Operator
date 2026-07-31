import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "../lib/api-tokens.js";
import { wsBroadcaster, type WsEnvelope } from "../lib/broadcaster.js";
import {
  findOutstandingPushWorkPage,
  type OutstandingPushWorkCursor,
} from "../lib/ai/push-work.js";
import { verifyOperatorBearer } from "../lib/bearer-auth.js";
import { log } from "../lib/logger.js";
import {
  readSessionFromCookieHeader,
  sessionIsExpired,
  type AuthVariables,
} from "../lib/session.js";

export const wsRouter = new Hono<{ Variables: AuthVariables }>();

wsRouter.get("/status", (c) => c.json({ error: "upgrade_required" }, 426));

type SubscriberKind = "operator" | "worker";

type LiveSocket = WebSocket & {
  isAlive?: boolean;
  clientId?: string;
  subscriberKind?: SubscriberKind;
};

// Per-client outbound backpressure cap. When the buffered amount exceeds
// this, the slow consumer is dropped with code 1009 ("message too big") so
// one stuck client can't pin the whole broadcaster.
const MAX_BUFFERED_BYTES = 1_048_576; // 1 MiB
const REPLAY_WORK_BATCH_SIZE = 100;
const REPLAY_BUFFER_YIELD_BYTES = MAX_BUFFERED_BYTES / 2;

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

// Authorize a status-socket upgrade and classify the connection. Browser
// clients present the operator session cookie; native operator clients
// (iOS/watchOS/tvOS, the Rust CLI) present an `Authorization: Bearer` Authentik
// access token; the push-mode Transcription worker (macOS + iOS) presents its
// static Argon2id API token, verified the same way as the `/v1/worker` REST
// callbacks.
//
// The returned kind scopes what the subscriber may receive: "operator"
// connections get every non-`work` envelope (status/system/message, which carry
// audio SAS URLs and transcript/moderation content); "worker" connections get
// ONLY `work` envelopes. A generic (operator-scoped) API token therefore cannot
// read work events, and a worker-scoped token cannot read message content.
// Returns `null` when the upgrade is not authorized.
const authorizeStatusUpgrade = async (request: IncomingMessage): Promise<SubscriberKind | null> => {
  const session = await readSessionFromCookieHeader(request.headers.cookie);
  if (session && !sessionIsExpired(session)) return "operator";

  const token = bearerTokenFromHeader(request.headers.authorization);
  if (!token) return null;
  try {
    const result = await verifyOperatorBearer(token);
    if (result.ok) return "operator";
  } catch {
    // A transient JWKS/network failure must not crash the upgrade handler;
    // fall through to the static API-token check and, failing that, deny.
  }
  try {
    const apiToken = await verifyToken(token);
    if (!apiToken) return null;
    // `scope` is stored as an unconstrained string; classify known values
    // explicitly and fail closed on anything unexpected.
    if (apiToken.scope === "worker") return "worker";
    if (apiToken.scope === "operator") return "operator";
    return null;
  } catch {
    return null;
  }
};

// Whether a subscriber of the given kind should receive an envelope. Worker
// connections are limited to `work` events; operator connections receive
// everything else (never raw `work`, which is internal scheduling).
const envelopeVisibleTo = (kind: SubscriberKind, envelope: WsEnvelope): boolean =>
  kind === "worker" ? envelope.kind === "work" : envelope.kind !== "work";

const sendEnvelopeToSocket = (ws: LiveSocket, envelope: WsEnvelope): void => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const kind = ws.subscriberKind ?? "operator";
  if (!envelopeVisibleTo(kind, envelope)) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(1009, "status socket slow consumer");
    return;
  }
  ws.send(JSON.stringify(envelope));
};

const replayOutstandingWork = (ws: LiveSocket): void => {
  void (async () => {
    try {
      let cursor: OutstandingPushWorkCursor | undefined;
      while (ws.readyState === WebSocket.OPEN) {
        const page = await findOutstandingPushWorkPage({
          limit: REPLAY_WORK_BATCH_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        for (const work of page.work) {
          while (
            ws.readyState === WebSocket.OPEN &&
            ws.bufferedAmount > REPLAY_BUFFER_YIELD_BYTES
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          sendEnvelopeToSocket(ws, {
            kind: "work",
            messageId: work.messageId,
            needs: work.needs,
          });
        }
        if (!page.hasMore) return;
        cursor = page.cursor;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      log.warn({ err }, "failed to replay outstanding worker work");
    }
  })();
};

export interface StatusWebSocketHandle {
  close(): Promise<void>;
}

export const attachStatusWebSocket = (server: ServerType): StatusWebSocketHandle => {
  const wss = new WebSocketServer({ noServer: true });
  let closePromise: Promise<void> | null = null;
  let closing = false;
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

  wss.on("connection", (ws: LiveSocket, _request: IncomingMessage, kind?: SubscriberKind) => {
    if (closing || ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      return;
    }
    ws.isAlive = true;
    ws.clientId = randomUUID();
    if (kind) ws.subscriberKind = kind;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("close", () => {
      if (ws.clientId) wsBroadcaster.unsubscribe(ws.clientId);
    });
    wsBroadcaster.subscribe(ws.clientId, (envelope) => {
      sendEnvelopeToSocket(ws, envelope);
    });
  });

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isStatusWsPath(request)) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      void (async () => {
        const kind = await authorizeStatusUpgrade(request);
        if (closing || ws.readyState !== WebSocket.OPEN) {
          ws.terminate();
          return;
        }
        if (!kind) {
          closePolicyViolation(ws);
          return;
        }
        const liveSocket = ws as LiveSocket;
        liveSocket.subscriberKind = kind;
        wss.emit("connection", liveSocket, request, kind);
        if (kind === "worker") setImmediate(() => replayOutstandingWork(liveSocket));
      })();
    });
  };
  server.on("upgrade", handleUpgrade);

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(heartbeat);
    server.off("upgrade", handleUpgrade);
    for (const ws of wss.clients) ws.terminate();
    closePromise = new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    return closePromise;
  };
  server.once("close", () => {
    void close();
  });
  return { close };
};
