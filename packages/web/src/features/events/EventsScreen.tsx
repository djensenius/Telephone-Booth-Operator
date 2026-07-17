import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BoothEventType } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useEventsList } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

// Pull a short, human-readable summary out of an arbitrary event payload so
// `error`/`log` events are diagnosable from the table instead of showing an
// empty cell. When the payload is a structured object we expose it as an
// expandable detail (`hasPayload`) whose full JSON is serialized lazily on
// expansion — event payloads are unbounded (`BoothEventSchema.payload` is
// `z.unknown()`) and this screen renders up to 100 rows, so serializing every
// payload up front would be wasteful. The generic fallback label is
// "View payload" when there is no obvious message field.
function eventDetail(payload: unknown): { summary: string; hasPayload: boolean } {
  if (payload === null || payload === undefined) return { summary: "—", hasPayload: false };
  if (typeof payload === "string") return { summary: payload, hasPayload: false };
  if (typeof payload === "number" || typeof payload === "boolean") {
    return { summary: String(payload), hasPayload: false };
  }
  if (typeof payload !== "object") return { summary: "View payload", hasPayload: false };
  const record = payload as Record<string, unknown>;
  const candidate = record.message ?? record.error ?? record.reason ?? record.detail;
  const summary = typeof candidate === "string" && candidate.length > 0 ? candidate : "View payload";
  return { summary, hasPayload: true };
}

// Expandable payload cell. The full JSON is only serialized the first time the
// operator opens the disclosure, keeping large payloads off the render path
// while every row is collapsed.
function EventPayloadCell({
  summary,
  payload,
}: {
  readonly summary: string;
  readonly payload: unknown;
}): JSX.Element {
  const [serialized, setSerialized] = useState<string | null>(null);
  return (
    <details
      className="events-screen__detail"
      onToggle={(event) => {
        if (event.currentTarget.open && serialized === null) {
          setSerialized(JSON.stringify(payload, null, 2));
        }
      }}
    >
      <summary>{summary}</summary>
      <pre>{serialized ?? "Expand to load payload…"}</pre>
    </details>
  );
}

const EVENT_TYPES: readonly BoothEventType[] = [
  "call_started",
  "call_ended",
  "digit_dialed",
  "state_transition",
  "recording_started",
  "recording_stopped",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "audio_device_change",
  "operator_request",
  "operator_response",
  "error",
  "log",
  "system_sample",
  "gpio_edge",
];

export function EventsScreen(): JSX.Element {
  const [type, setType] = useState<BoothEventType | "">("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const query = useEventsList({
    ...(type ? { type: [type] as readonly BoothEventType[] } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 100,
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  return (
    <GlassPanel title="Booth events" className="feature-screen events-screen">
      <p className="screen-kicker">Observability</p>
      <h1>Events</h1>
      <p>Append-only log of everything the booth has done since you started watching.</p>

      <div className="events-screen__filters" role="group" aria-label="Event filters">
        <label>
          Type:{" "}
          <select
            value={type}
            onChange={(event) => {
              const value = event.target.value;
              setCursor(undefined);
              setType(value === "" ? "" : (value as BoothEventType));
            }}
          >
            <option value="">All</option>
            {EVENT_TYPES.map((eventType) => (
              <option key={eventType} value={eventType}>
                {eventType}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading && items.length === 0 ? (
        <FeatureSkeleton label="Tuning to the wire…" />
      ) : null}
      {query.error ? <FeatureError message="Could not read the event log." /> : null}
      {!query.isLoading && !query.error && items.length === 0 ? (
        <FeatureEmpty title="Quiet line">No events match the current filter yet.</FeatureEmpty>
      ) : null}

      {items.length > 0 ? (
        <div className="events-screen__table-wrap">
          <table className="events-screen__table">
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">Type</th>
                <th scope="col">Session</th>
                <th scope="col">Recording</th>
                <th scope="col">Booth</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <time dateTime={event.receivedAt}>
                      {new Date(event.receivedAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    <code>{event.type}</code>
                  </td>
                  <td>
                    {event.sessionId ? (
                      <Link to="/sessions/$id" params={{ id: event.sessionId }}>
                        {event.sessionId.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{event.recordingId ?? "—"}</td>
                  <td>{event.boothId}</td>
                  <td>
                    {(() => {
                      const detail = eventDetail(event.payload);
                      if (!detail.hasPayload) {
                        return <span className="events-screen__detail">{detail.summary}</span>;
                      }
                      return <EventPayloadCell summary={detail.summary} payload={event.payload} />;
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {query.data?.nextCursor ? (
        <button
          type="button"
          className="events-screen__more"
          onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
        >
          Older events →
        </button>
      ) : null}
    </GlassPanel>
  );
}
