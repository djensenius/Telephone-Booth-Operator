import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  BoothState,
  BoothStatus,
  BoothSystemSnapshot,
} from "@telephone-booth-operator/shared";
import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";
import { apiQueryKeys, useStatusCurrent, useStatusHistory } from "../../lib/api-client.js";
import { useBoothWebSocket } from "../../lib/booth-websocket.js";
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

export function StatusScreen(): JSX.Element {
  const { setLastStatusAt, setRuntimeMode, setStatus } = useBoothStatus();
  const queryClient = useQueryClient();
  const ws = useBoothWebSocket();
  const [liveStatus, setLiveStatus] = useState<BoothStatus | null>(null);
  const wsState = ws.state;
  const statusQuery = useStatusCurrent({ paused: wsState === "live" });
  const historyQuery = useStatusHistory({ paused: wsState === "live" });

  useEffect(() => {
    setLiveStatus(statusQuery.data ?? null);
    if (statusQuery.data?.updatedAt) {
      setLastStatusAt(new Date(statusQuery.data.updatedAt));
    }
  }, [statusQuery.data, setLastStatusAt]);

  // Subscribe to the shared /v1/ws/status stream for the envelopes this
  // screen renders (status/system/message). Installation-rollover handling
  // is bridged app-wide in `InstallationRolloverBridge` so a console on any
  // route re-scopes without a reload.
  useEffect(() => {
    const offEnvelope = ws.subscribe((envelope) => {
      if (envelope.kind === "status") {
        const status = envelope.status;
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
      } else if (envelope.kind === "system") {
        queryClient.setQueryData<{
          boothId: string;
          snapshot: BoothSystemSnapshot;
          receivedAt: string;
          version: string | null;
        }>(["system", envelope.boothId], {
          boothId: envelope.boothId,
          snapshot: envelope.snapshot,
          receivedAt: envelope.receivedAt,
          version: envelope.version ?? null,
        });
      } else if (envelope.kind === "message") {
        const message = envelope.message;
        queryClient.setQueryData(apiQueryKeys.message(message.id), message);
        void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
        void queryClient.invalidateQueries({ queryKey: apiQueryKeys.transcriptions(message.id) });
      }
    });
    const offLegacy = ws.subscribeLegacyStatus((status) => {
      setLiveStatus(status);
      setLastStatusAt(new Date(status.updatedAt));
      queryClient.setQueryData(apiQueryKeys.status, status);
    });
    return () => {
      offEnvelope();
      offLegacy();
    };
  }, [ws, queryClient, setLastStatusAt]);

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
