import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { GlassPanel } from "../../components/booth/index.js";
import { useSession, useSessionsList } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function SessionsScreen(): JSX.Element {
  const query = useSessionsList();
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  return (
    <GlassPanel title="Call sessions" className="feature-screen sessions-screen">
      <p className="screen-kicker">Observability</p>
      <h1>Sessions</h1>
      <p>Each pickup-to-hangup is grouped into a session with its outcome and dialed digits.</p>

      {query.isLoading && items.length === 0 ? <FeatureSkeleton label="Sorting the cords…" /> : null}
      {query.error ? <FeatureError message="Could not read the session log." /> : null}
      {!query.isLoading && !query.error && items.length === 0 ? (
        <FeatureEmpty title="No calls yet">When someone picks up the booth, a session appears here.</FeatureEmpty>
      ) : null}

      {items.length > 0 ? (
        <div className="sessions-screen__table-wrap">
          <table className="sessions-screen__table">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Outcome</th>
                <th scope="col">Digits</th>
                <th scope="col">Duration</th>
                <th scope="col">Session</th>
              </tr>
            </thead>
            <tbody>
              {items.map((session) => (
                <tr key={session.id}>
                  <td>
                    <time dateTime={session.startedAt}>{new Date(session.startedAt).toLocaleString()}</time>
                  </td>
                  <td>
                    <code>{session.outcome ?? "live"}</code>
                  </td>
                  <td>{session.digitsDialed ?? "—"}</td>
                  <td>{fmtDuration(session.durationMs)}</td>
                  <td>
                    <Link to="/sessions/$id" params={{ id: session.id }}>
                      {session.id.slice(0, 8)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </GlassPanel>
  );
}

export function SessionDetailScreen({ id }: { readonly id: string }): JSX.Element {
  const query = useSession(id);
  const session = query.data;

  return (
    <GlassPanel title="Session detail" className="feature-screen session-detail-screen">
      <p className="screen-kicker">
        <Link to="/sessions">← All sessions</Link>
      </p>
      <h1>
        Session <code>{id.slice(0, 8)}</code>
      </h1>
      {query.isLoading ? <FeatureSkeleton label="Pulling the call sheet…" /> : null}
      {query.error ? <FeatureError message="Could not read this session." /> : null}
      {session ? (
        <>
          <dl className="session-detail-screen__grid">
            <div>
              <dt>Started</dt>
              <dd>{new Date(session.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>{session.endedAt ? new Date(session.endedAt).toLocaleString() : "—"}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd><code>{session.outcome ?? "live"}</code></dd>
            </div>
            <div>
              <dt>Digits dialed</dt>
              <dd>{session.digitsDialed ?? "—"}</dd>
            </div>
            <div>
              <dt>Recording</dt>
              <dd>{session.recordingId ?? "—"}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{fmtDuration(session.durationMs)}</dd>
            </div>
          </dl>
          <h2>Event timeline</h2>
          {session.events.length === 0 ? (
            <FeatureEmpty title="No events">This session has no recorded events.</FeatureEmpty>
          ) : (
            <ol className="session-detail-screen__timeline">
              {session.events.map((event) => (
                <li key={event.id}>
                  <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString()}</time>
                  <code>{event.type}</code>
                  {event.recordingId ? <span> · recording {event.recordingId}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </GlassPanel>
  );
}
