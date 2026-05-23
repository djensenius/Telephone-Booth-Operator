import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WsEnvelopeSchema, BoothStatusSchema } from "@telephone-booth-operator/shared";
import type { BoothState, BoothStatus, BoothSystemSnapshot } from "@telephone-booth-operator/shared";
import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";
import { apiQueryKeys, useStatusCurrent, useStatusHistory } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

function displayState(state: BoothState): string {
  return state.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
}

function hookLabel(state: BoothState): "On hook" | "Off hook" {
  return state === "idle" || state === "error" ? "On hook" : "Off hook";
}

function boothDisplay(state: BoothState): "idle" | "playing" | "recording" | "error" {
  if (state === "error") return "error";
  if (state === "recording" || state === "uploading") return "recording";
  if (state === "playingMessage" || state === "playingQuestion" || state === "playingInstructions") return "playing";
  return "idle";
}

function wsUrl(): string {
  const base = typeof import.meta.env.VITE_API_BASE_URL === "string" ? import.meta.env.VITE_API_BASE_URL : window.location.origin;
  const url = new URL("/v1/ws/status", base.length === 0 ? window.location.origin : base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function StatusScreen(): JSX.Element {
  const { setConnectionStatus, setLastError, setStatus } = useBoothStatus();
  const queryClient = useQueryClient();
  const statusQuery = useStatusCurrent();
  const historyQuery = useStatusHistory();
  const [liveStatus, setLiveStatus] = useState<BoothStatus | null>(null);
  const [wsState, setWsState] = useState("polling");

  useEffect(() => setLiveStatus(statusQuery.data ?? null), [statusQuery.data]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return undefined;
    const socket = new WebSocket(wsUrl());
    setWsState("connecting");
    socket.addEventListener("open", () => {
      setWsState("live");
      setConnectionStatus("connected");
      setLastError(null);
    });
    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const envelope = WsEnvelopeSchema.safeParse(raw);
      if (envelope.success) {
        if (envelope.data.kind === "status") {
          const status = envelope.data.status;
          setLiveStatus(status);
          queryClient.setQueryData(apiQueryKeys.status, status);
          queryClient.setQueryData(apiQueryKeys.statusHistory, (current: { readonly items: readonly BoothStatus[] } | undefined) => ({ items: [status, ...(current?.items ?? [])].slice(0, 50) }));
        } else if (envelope.data.kind === "system") {
          queryClient.setQueryData<{ boothId: string; snapshot: BoothSystemSnapshot; receivedAt: string }>(
            ["system", envelope.data.boothId],
            { boothId: envelope.data.boothId, snapshot: envelope.data.snapshot, receivedAt: envelope.data.receivedAt },
          );
        }
        return;
      }
      // Back-compat: tolerate the legacy bare-status frame from older API
      // builds. The op-api PR migrated the wire to a discriminated envelope.
      const legacy = BoothStatusSchema.safeParse(raw);
      if (legacy.success) {
        setLiveStatus(legacy.data);
        queryClient.setQueryData(apiQueryKeys.status, legacy.data);
      }
    });
    socket.addEventListener("error", () => {
      setWsState("polling");
      setConnectionStatus("disconnected");
      setLastError("Live status socket is busy; polling every five seconds.");
    });
    socket.addEventListener("close", () => setWsState("polling"));
    return () => socket.close();
  }, [queryClient, setConnectionStatus, setLastError]);

  useEffect(() => {
    if (liveStatus) setStatus(boothDisplay(liveStatus.state));
  }, [liveStatus, setStatus]);

  const history = useMemo(() => historyQuery.data?.items ?? [], [historyQuery.data]);
  const current = liveStatus ?? history[0] ?? null;

  return (
    <GlassPanel title="Live status panel" className="feature-screen status-screen">
      <p className="screen-kicker">Digit 1</p>
      <h1>Status</h1>
      <p>The switchboard watches the phone client state machine and keeps the booth lamps in step.</p>
      {statusQuery.isLoading && current === null ? <FeatureSkeleton /> : null}
      {statusQuery.error ? <FeatureError message="Could not read the booth status line." /> : null}
      {current === null && !statusQuery.isLoading ? <FeatureEmpty title="No signal yet">No status snapshots have arrived from the booth.</FeatureEmpty> : null}
      {current === null ? null : (
        <>
          <section className={`status-indicator status-indicator--${hookLabel(current.state) === "On hook" ? "on" : "off"}`} aria-label="Hook position">
            <span className="status-indicator__receiver" aria-hidden="true" />
            <div>
              <p className="screen-kicker">Receiver</p>
              <strong>{hookLabel(current.state)}</strong>
              <span>{`${displayState(current.state)} · updated ${new Date(current.updatedAt).toLocaleString()}`}</span>
            </div>
          </section>
          <details className="feature-help">
            <summary>What is this?</summary>
            <p>The phone client reports each state as the handset moves from hook, to dial tone, to question playback, beep, recording, upload, and message playback.</p>
          </details>
          <dl className="status-grid">
            <div><dt>Booth state</dt><dd>{displayState(current.state)}</dd></div>
            <div><dt>Line</dt><dd>{wsState}</dd></div>
            <div><dt>Last error</dt><dd>{current.lastError ?? "Clear"}</dd></div>
          </dl>
          <div className="feature-table-wrap">
            <table className="feature-table">
              <caption>Last 50 status snapshots</caption>
              <thead><tr><th>Time</th><th>State</th><th>Question</th><th>Message</th></tr></thead>
              <tbody>
                {history.map((item) => (
                  <tr key={`${item.updatedAt}-${item.state}`}>
                    <td>{new Date(item.updatedAt).toLocaleString()}</td>
                    <td>{displayState(item.state)}</td>
                    <td>{item.currentQuestionId ?? "—"}</td>
                    <td>{item.currentMessageId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </GlassPanel>
  );
}
