import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WsEnvelopeSchema, BoothStatusSchema } from "@telephone-booth-operator/shared";
import type {
  BoothState,
  BoothStatus,
  BoothSystemSnapshot,
} from "@telephone-booth-operator/shared";
import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";
import {
  apiQueryKeys,
  apiWebSocketUrlFor,
  invalidateInstallationScopedQueries,
  useStatusCurrent,
  useStatusHistory,
} from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import {
  STATUS_HISTORY_DISPLAY_LIMIT,
  collapseStatusHistory,
  firstSeenAtOf,
  isNewerThan,
  mergeLiveStatus,
  repeatCountOf,
} from "../../lib/status-history.js";

function sinceLabel(firstSeenAt: string, updatedAt: string): string {
  const start = new Date(firstSeenAt);
  const end = new Date(updatedAt);
  return start.toDateString() === end.toDateString()
    ? start.toLocaleTimeString()
    : start.toLocaleString();
}

function displayState(state: BoothState): string {
  if (state === "callUnavailable") return "Call unavailable";
  return state.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
}

function hookLabel(state: BoothState): "On hook" | "Off hook" {
  return state === "idle" || state === "error" ? "On hook" : "Off hook";
}

function boothDisplay(state: BoothState): "idle" | "playing" | "recording" | "error" {
  if (state === "error") return "error";
  if (state === "recording" || state === "uploading") return "recording";
  if (
    state === "playingMessage" ||
    state === "playingQuestion" ||
    state === "playingInstructions" ||
    state === "callUnavailable"
  )
    return "playing";
  return "idle";
}

function wsUrl(): string {
  return apiWebSocketUrlFor("/v1/ws/status");
}

export function StatusScreen(): JSX.Element {
  const { setConnectionStatus, setLastError, setLastStatusAt, setRuntimeMode, setStatus } =
    useBoothStatus();
  const queryClient = useQueryClient();
  const [liveStatus, setLiveStatus] = useState<BoothStatus | null>(null);
  const [wsState, setWsState] = useState("polling");
  const statusQuery = useStatusCurrent({ paused: wsState === "live" });
  const historyQuery = useStatusHistory({ paused: wsState === "live" });

  useEffect(() => {
    setLiveStatus(statusQuery.data ?? null);
    if (statusQuery.data?.updatedAt) {
      setLastStatusAt(new Date(statusQuery.data.updatedAt));
    }
  }, [statusQuery.data, setLastStatusAt]);

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
          // Frames can arrive out of order, so an older one is recorded in the
          // history but never becomes the displayed current status.
          const cached = queryClient.getQueryData<BoothStatus>(apiQueryKeys.status) ?? null;
          if (isNewerThan(status, cached)) {
            setLiveStatus(status);
            setLastStatusAt(new Date(status.updatedAt));
            queryClient.setQueryData(apiQueryKeys.status, status);
          }
          queryClient.setQueryData(
            apiQueryKeys.statusHistory,
            (current: { readonly items: readonly BoothStatus[] } | undefined) => ({
              items: mergeLiveStatus(current?.items ?? [], status),
            }),
          );
        } else if (envelope.data.kind === "system") {
          queryClient.setQueryData<{
            boothId: string;
            snapshot: BoothSystemSnapshot;
            receivedAt: string;
            version: string | null;
          }>(["system", envelope.data.boothId], {
            boothId: envelope.data.boothId,
            snapshot: envelope.data.snapshot,
            receivedAt: envelope.data.receivedAt,
            version: envelope.data.version ?? null,
          });
        } else if (envelope.data.kind === "message") {
          const message = envelope.data.message;
          queryClient.setQueryData(apiQueryKeys.message(message.id), message);
          void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
          void queryClient.invalidateQueries({ queryKey: apiQueryKeys.transcriptions(message.id) });
        } else if (envelope.data.kind === "installation") {
          // Rollover on another console: the active era changed, so every
          // scoped read is stale. Mirror what a local start/end mutation
          // invalidates so this browser re-scopes without a reload.
          invalidateInstallationScopedQueries(queryClient);
        }
        return;
      }
      // Back-compat: tolerate the legacy bare-status frame from older API
      // builds. The op-api PR migrated the wire to a discriminated envelope.
      const legacy = BoothStatusSchema.safeParse(raw);
      if (legacy.success) {
        setLiveStatus(legacy.data);
        setLastStatusAt(new Date(legacy.data.updatedAt));
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
  }, [queryClient, setConnectionStatus, setLastError, setLastStatusAt]);

  useEffect(() => {
    if (liveStatus) setStatus(boothDisplay(liveStatus.state));
  }, [liveStatus, setStatus]);

  useEffect(() => {
    setRuntimeMode(liveStatus?.runtimeMode ?? null);
  }, [liveStatus, setRuntimeMode]);

  const history = useMemo(
    () =>
      collapseStatusHistory(historyQuery.data?.items ?? []).slice(0, STATUS_HISTORY_DISPLAY_LIMIT),
    [historyQuery.data],
  );
  const current = liveStatus ?? history[0] ?? null;

  return (
    <GlassPanel title="Live status panel" className="feature-screen status-screen">
      <p className="screen-kicker">Digit 1</p>
      <h1>Status</h1>
      <p>
        The switchboard watches the phone client state machine and keeps the console status in step.
      </p>
      {statusQuery.isLoading && current === null ? <FeatureSkeleton /> : null}
      {statusQuery.error ? <FeatureError message="Could not read the booth status line." /> : null}
      {current === null && !statusQuery.isLoading ? (
        <FeatureEmpty title="No signal yet">
          No status snapshots have arrived from the booth.
        </FeatureEmpty>
      ) : null}
      {current === null ? null : (
        <>
          <section
            className={`status-indicator status-indicator--${hookLabel(current.state) === "On hook" ? "on" : "off"}`}
            aria-label="Hook position"
          >
            <div>
              <p className="screen-kicker">Receiver</p>
              <strong>{hookLabel(current.state)}</strong>
              <span>{`${displayState(current.state)} · since ${new Date(firstSeenAtOf(current)).toLocaleString()} · updated ${new Date(current.updatedAt).toLocaleString()}`}</span>
            </div>
          </section>
          <details className="feature-help">
            <summary>What is this?</summary>
            <p>
              The phone client reports each state as the handset moves from hook, to dial tone, to
              question playback, beep, recording, upload, and message playback.
            </p>
          </details>
          <dl className="status-grid">
            <div>
              <dt>Booth state</dt>
              <dd>{displayState(current.state)}</dd>
            </div>
            <div>
              <dt>Line</dt>
              <dd>{wsState}</dd>
            </div>
            <div>
              <dt>Last error</dt>
              <dd>{current.lastError ?? "Clear"}</dd>
            </div>
          </dl>
          <div className="feature-table-wrap">
            <table className="feature-table">
              <caption>
                Last 50 booth statuses. The booth repeats its status on a heartbeat, so identical
                reports are counted rather than listed.
              </caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>State</th>
                  <th>Reports</th>
                  <th>Question</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, index) => {
                  const repeats = repeatCountOf(item);
                  const firstSeenAt = firstSeenAtOf(item);
                  return (
                    // Snapshot ids aren't on the wire and timestamps can tie,
                    // so position in the collapsed list is the row identity.
                    <tr key={`${index}-${firstSeenAt}-${item.state}`}>
                      <td>
                        <time dateTime={item.updatedAt}>
                          {new Date(item.updatedAt).toLocaleString()}
                        </time>
                        {repeats > 1 ? (
                          <span className="status-screen__since">
                            {`since ${sinceLabel(firstSeenAt, item.updatedAt)}`}
                          </span>
                        ) : null}
                      </td>
                      <td>{displayState(item.state)}</td>
                      <td
                        title={`${repeats} report${repeats === 1 ? "" : "s"}`}
                      >{`×${repeats}`}</td>
                      <td>{item.currentQuestionId ?? "—"}</td>
                      <td>{item.currentMessageId ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </GlassPanel>
  );
}
