import type { JSX, ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BoothStatusSchema, WsEnvelopeSchema } from "@telephone-booth-operator/shared";
import type { BoothStatus, WsEnvelope } from "@telephone-booth-operator/shared";
import { useBoothStatus } from "../components/booth/BoothStatusContext.js";
import {
  apiQueryKeys,
  apiWebSocketUrlFor,
  invalidateInstallationScopedQueries,
} from "./api-client.js";
import { isNewerThan, mergeLiveStatus } from "./status-history.js";

// One shared `/v1/ws/status` connection for the whole authenticated app. The
// socket must live above the router so envelopes (installation rollovers,
// message pushes, system snapshots) reach the query cache no matter which
// screen the operator is on. StatusScreen still owns the presentation of
// booth status/history, but it consumes this shared subscription rather than
// opening its own socket.

type BoothWebSocketState = "polling" | "connecting" | "live";
type EnvelopeListener = (envelope: WsEnvelope) => void;
type LegacyStatusListener = (status: BoothStatus) => void;

export interface BoothWebSocketApi {
  readonly state: BoothWebSocketState;
  subscribe(listener: EnvelopeListener): () => void;
  subscribeLegacyStatus(listener: LegacyStatusListener): () => void;
}

const BoothWebSocketContext = createContext<BoothWebSocketApi | null>(null);

// Reconnect backoff bounds. Short enough that a server restart costs a few
// seconds of polling, long enough that a down API is not hammered.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function BoothWebSocketProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const [state, setState] = useState<BoothWebSocketState>("polling");
  const listenersRef = useRef<Set<EnvelopeListener>>(new Set());
  const legacyRef = useRef<Set<LegacyStatusListener>>(new Set());

  // Latched via ref so we can call setters from the socket's lifetime without
  // re-running the effect (and re-opening the socket) every time the
  // BoothStatus context re-renders.
  const boothStatus = useBoothStatus();
  const boothStatusRef = useRef(boothStatus);
  useEffect(() => {
    boothStatusRef.current = boothStatus;
  }, [boothStatus]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof WebSocket === "undefined") return undefined;

    // The provider lives for the whole authenticated session now, so nothing
    // remounts it after a server restart or a network blip. Without a retry a
    // single dropped socket would cost every later envelope, so reconnect with
    // a bounded backoff for as long as the provider is mounted.
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const reconnect = (): void => {
      if (closed || retry !== undefined) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        if (!closed) connect();
      }, delay);
    };

    function connect(): void {
      const current = new WebSocket(apiWebSocketUrlFor("/v1/ws/status"));
      socket = current;
      setState("connecting");

      // Only the socket we are still holding gets to schedule a retry. A
      // failed socket's `close` can land after its replacement is already
      // open, and acting on it would leave two live connections duplicating
      // every envelope.
      const retire = (): void => {
        if (socket !== current) return;
        socket = undefined;
        setState("polling");
        reconnect();
      };

      current.addEventListener("open", () => {
        attempt = 0;
        setState("live");
        boothStatusRef.current.setConnectionStatus("connected");
        boothStatusRef.current.setLastError(null);
      });
      current.addEventListener("message", (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const envelope = WsEnvelopeSchema.safeParse(raw);
        if (envelope.success) {
          // Iterate a snapshot: listeners may unsubscribe themselves during
          // dispatch (React 19 StrictMode double-invokes cleanups).
          for (const listener of Array.from(listenersRef.current)) listener(envelope.data);
          return;
        }
        // Back-compat: tolerate the legacy bare-status frame from older API
        // builds. The op-api PR migrated the wire to a discriminated envelope.
        const legacy = BoothStatusSchema.safeParse(raw);
        if (legacy.success) {
          for (const listener of Array.from(legacyRef.current)) listener(legacy.data);
        }
      });
      current.addEventListener("error", () => {
        if (socket !== current) return;
        boothStatusRef.current.setConnectionStatus("disconnected");
        boothStatusRef.current.setLastError(
          "Live status socket is busy; polling every five seconds.",
        );
        // Retiring happens on the `close` that always follows an error, so a
        // socket is only ever replaced once.
        current.close();
      });
      current.addEventListener("close", retire);
    }

    connect();
    return () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    };
  }, [enabled]);

  const api = useMemo<BoothWebSocketApi>(
    () => ({
      state,
      subscribe(listener: EnvelopeListener): () => void {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      subscribeLegacyStatus(listener: LegacyStatusListener): () => void {
        legacyRef.current.add(listener);
        return () => {
          legacyRef.current.delete(listener);
        };
      },
    }),
    [state],
  );

  return <BoothWebSocketContext.Provider value={api}>{children}</BoothWebSocketContext.Provider>;
}

// Always returns a value: when the provider is missing (unauthenticated
// routes, unit tests that render a screen in isolation), we hand back an
// inert stub so consumers don't have to guard for provider presence.
const INERT_API: BoothWebSocketApi = {
  state: "polling",
  subscribe: () => () => {},
  subscribeLegacyStatus: () => () => {},
};

export function useBoothWebSocket(): BoothWebSocketApi {
  return useContext(BoothWebSocketContext) ?? INERT_API;
}

// Always-mounted bridge: every envelope that belongs in the query cache is
// applied here rather than on the screen that happens to render it. A console
// parked on Messages must still see a pushed recording, and one on any route
// must re-scope when a rollover happens on another console. Screens subscribe
// only for their own presentation state.
export function BoothEnvelopeBridge(): null {
  const ws = useBoothWebSocket();
  const queryClient = useQueryClient();
  useEffect(() => {
    return ws.subscribe((envelope) => {
      if (envelope.kind === "installation") {
        invalidateInstallationScopedQueries(queryClient);
        return;
      }
      if (envelope.kind === "status") {
        const status = envelope.status;
        // Frames can arrive out of order, so an older one joins the history but
        // never becomes the current status.
        const cached = queryClient.getQueryData<BoothStatus>(apiQueryKeys.status) ?? null;
        if (isNewerThan(status, cached)) queryClient.setQueryData(apiQueryKeys.status, status);
        queryClient.setQueryData(
          apiQueryKeys.statusHistory,
          (current: { readonly items: readonly BoothStatus[] } | undefined) => ({
            items: mergeLiveStatus(current?.items ?? [], status),
          }),
        );
        return;
      }
      if (envelope.kind === "system") {
        queryClient.setQueryData(apiQueryKeys.system(envelope.boothId), {
          boothId: envelope.boothId,
          snapshot: envelope.snapshot,
          receivedAt: envelope.receivedAt,
          version: envelope.version ?? null,
        });
        return;
      }
      if (envelope.kind === "message") {
        const message = envelope.message;
        queryClient.setQueryData(apiQueryKeys.message(message.id), message);
        void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
        void queryClient.invalidateQueries({ queryKey: apiQueryKeys.transcriptions(message.id) });
      }
    });
  }, [ws, queryClient]);
  return null;
}
