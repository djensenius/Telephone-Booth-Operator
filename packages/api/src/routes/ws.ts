import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { statusBroadcaster } from "../lib/broadcaster.js";
import { readSessionFromCookieHeader, type AuthVariables } from "../lib/session.js";

export const wsRouter = new Hono<{ Variables: AuthVariables }>();

wsRouter.get("/status", (c) => c.json({ error: "upgrade_required" }, 426));

type LiveSocket = WebSocket & { isAlive?: boolean; clientId?: string };

const isStatusWsPath = (request: IncomingMessage): boolean => {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  return url.pathname === "/v1/ws/status";
};

const closePolicyViolation = (ws: WebSocket): void => {
  ws.close(1008, "operator session required");
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
      if (ws.clientId) statusBroadcaster.unsubscribe(ws.clientId);
    });
    statusBroadcaster.subscribe(ws.clientId, (status) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(status));
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isStatusWsPath(request)) return;

    wss.handleUpgrade(request, socket, head, async (ws) => {
      const session = await readSessionFromCookieHeader(request.headers.cookie);
      if (!session || session.expiresAt.getTime() <= Date.now()) {
        closePolicyViolation(ws);
        return;
      }
      wss.emit("connection", ws, request);
    });
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });
};
