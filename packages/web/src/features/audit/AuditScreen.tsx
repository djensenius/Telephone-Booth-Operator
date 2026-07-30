import type { JSX } from "react";
import { useState } from "react";
import type { AuditLogEntry } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useAuditLogs } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

// Action families the operator is most likely to want. A trailing dot asks the
// API for every action in that family; an exact name asks for just that one.
const ACTION_FILTERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "All actions" },
  { value: "message.", label: "Messages (all)" },
  { value: "message.approve", label: "Approvals" },
  { value: "message.reject", label: "Rejections" },
  { value: "message.transcription.push", label: "Transcriptions" },
  { value: "message.translation.", label: "Translations" },
  { value: "message.moderation.push", label: "Moderations" },
  { value: "question.", label: "Questions" },
  { value: "instruction.", label: "Instructions" },
  { value: "apiToken.", label: "API tokens" },
  { value: "auth.login", label: "Sign-in" },
  { value: "admin.", label: "Admin data" },
];

const ACTOR_TYPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "Anyone" },
  { value: "operator", label: "Operators" },
  { value: "apiToken", label: "API tokens" },
  { value: "anonymous", label: "Unauthenticated" },
  { value: "system", label: "System" },
];

function outcomeLabel(statusCode: number): string {
  // A successful sign-in ends in a 302 back to the console, so redirects are
  // successes, not refusals.
  if (statusCode < 400) return "ok";
  if (statusCode === 401 || statusCode === 403) return "denied";
  if (statusCode < 500) return "rejected";
  return "error";
}

// Metadata is small and action-specific, so it is rendered lazily behind a
// disclosure to keep the table scannable.
function MetadataCell({ entry }: { readonly entry: AuditLogEntry }): JSX.Element {
  const [serialized, setSerialized] = useState<string | null>(null);
  // Rejected writes often stop before a handler can name a target, so the
  // request itself is the only thing identifying what was attempted.
  const request = `${entry.method} ${entry.path}`;
  const target = entry.targetType
    ? `\n${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ""}`
    : "";
  return (
    <details
      className="audit-screen__detail"
      onToggle={(event) => {
        if (event.currentTarget.open && serialized === null) {
          const metadata =
            entry.metadata && Object.keys(entry.metadata).length > 0
              ? `\n${JSON.stringify(entry.metadata, null, 2)}`
              : "";
          setSerialized(`${request}${target}${metadata}`);
        }
      }}
    >
      <summary>View detail</summary>
      <pre>{serialized ?? "Expand to load detail…"}</pre>
    </details>
  );
}

export function AuditScreen(): JSX.Element {
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Cursors are forward-only, so stepping back means remembering where we
  // came from rather than asking the server for a previous page.
  const [history, setHistory] = useState<(string | undefined)[]>([]);

  const resetPaging = (): void => {
    setCursor(undefined);
    setHistory([]);
  };

  const query = useAuditLogs({
    ...(action ? { action } : {}),
    ...(actorType ? { actorType } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  });
  const items = query.data?.items ?? [];

  return (
    <GlassPanel title="Audit log" className="feature-screen audit-screen">
      <p className="screen-kicker">Observability</p>
      <h1>Audit log</h1>
      <p>
        Every write action against the operator API, with the operator or token that made it, the
        address it came from, and when. Booth telemetry heartbeats are excluded.
      </p>

      <div className="audit-screen__filters" role="group" aria-label="Audit log filters">
        <label>
          Action:{" "}
          <select
            value={action}
            onChange={(event) => {
              resetPaging();
              setAction(event.target.value);
            }}
          >
            {ACTION_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Actor:{" "}
          <select
            value={actorType}
            onChange={(event) => {
              resetPaging();
              setActorType(event.target.value);
            }}
          >
            {ACTOR_TYPES.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading && items.length === 0 ? (
        <FeatureSkeleton label="Pulling the ledger…" />
      ) : null}
      {query.error ? <FeatureError message="Could not read the audit log." /> : null}
      {!query.isLoading && !query.error && items.length === 0 ? (
        <FeatureEmpty title="Nothing on record">
          No write actions match the current filter yet.
        </FeatureEmpty>
      ) : null}

      {items.length > 0 ? (
        <div className="audit-screen__table-wrap">
          <table className="audit-screen__table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">From</th>
                <th scope="col">Outcome</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    {entry.actorLabel}
                    <span className="audit-screen__actor-type"> · {entry.actorType}</span>
                  </td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    {entry.targetType ? (
                      <>
                        {entry.targetType}
                        {entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{entry.ip ?? "—"}</td>
                  <td>
                    <span
                      className={`audit-screen__outcome audit-screen__outcome--${outcomeLabel(entry.statusCode)}`}
                    >
                      {entry.statusCode}
                    </span>
                  </td>
                  <td>
                    <MetadataCell entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {history.length > 0 || query.data?.nextCursor ? (
        <div className="audit-screen__paging" role="group" aria-label="Audit log pages">
          <button
            type="button"
            className="audit-screen__more"
            disabled={history.length === 0}
            onClick={() => {
              const previous = history[history.length - 1];
              setHistory(history.slice(0, -1));
              setCursor(previous);
            }}
          >
            ← Newer entries
          </button>
          <button
            type="button"
            className="audit-screen__more"
            disabled={!query.data?.nextCursor}
            onClick={() => {
              setHistory([...history, cursor]);
              setCursor(query.data?.nextCursor ?? undefined);
            }}
          >
            Older entries →
          </button>
        </div>
      ) : null}
    </GlassPanel>
  );
}
