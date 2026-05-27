import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { Message, Moderation, Transcription } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  useMessage,
  useMessageTranscriptions,
  useQuestionsList,
  useRemoderateMessage,
  useRetranscribeMessage,
} from "../../lib/api-client.js";
import { FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const listenedKey = (id: string): string => `booth.message.listened.${id}`;

function readListened(id: string): boolean {
  try {
    return window.localStorage.getItem(listenedKey(id)) === "true";
  } catch {
    return false;
  }
}

function writeListened(id: string, value: boolean): void {
  try {
    window.localStorage.setItem(listenedKey(id), String(value));
  } catch {
    // local preference only
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleString();
}

interface ModerationBadgeProps {
  readonly moderation: Moderation | null | undefined;
}

function moderationVariant(moderation: Moderation | null | undefined): {
  label: string;
  variant: string;
} {
  if (!moderation) return { label: "No moderation yet", variant: "none" };
  if (moderation.status === "pending") return { label: "Moderating…", variant: "pending" };
  if (moderation.status === "failed") return { label: "Moderation failed", variant: "failed" };
  if (moderation.recommendation === "approve") return { label: "Looks clean", variant: "approve" };
  if (moderation.recommendation === "reject")
    return { label: "Flagged for rejection", variant: "reject" };
  return { label: "Needs review", variant: "review" };
}

function ModerationBadge({ moderation }: ModerationBadgeProps): JSX.Element {
  const { label, variant } = moderationVariant(moderation);
  return <span className={`feature-badge feature-badge--moderation-${variant}`}>{label}</span>;
}

interface TranscriptCardProps {
  readonly message: Message;
  readonly onRetranscribe: () => void;
  readonly retranscribing: boolean;
  readonly retranscribeError: string | null;
}

function TranscriptCard({
  message,
  onRetranscribe,
  retranscribing,
  retranscribeError,
}: TranscriptCardProps): JSX.Element {
  const transcription = message.latestTranscription ?? null;
  return (
    <section className="feature-card feature-card--wide">
      <header className="feature-card-header">
        <h2>Transcript</h2>
        <button type="button" onClick={onRetranscribe} disabled={retranscribing}>
          {retranscribing ? "Re-running…" : "Re-run transcription"}
        </button>
      </header>
      {transcription === null ? (
        <p className="feature-empty">No transcription yet. Run one to populate moderation.</p>
      ) : transcription.status === "pending" ? (
        <p className="feature-empty">Transcription in progress…</p>
      ) : transcription.status === "failed" ? (
        <p className="feature-error">
          Transcription failed{transcription.error ? `: ${transcription.error}` : ""}.
        </p>
      ) : (
        <>
          <p className="feature-transcript-body">{transcription.text ?? ""}</p>
          {transcription.translationStatus === "succeeded" &&
          typeof transcription.translatedText === "string" &&
          transcription.translatedText.trim().length > 0 ? (
            <p className="feature-transcript-body feature-transcript-body--translated">
              <span className="feature-transcript-label">
                Translated from {transcription.language ?? "unknown"}
                {transcription.translatedLanguage
                  ? ` to ${transcription.translatedLanguage}`
                  : ""}
              </span>
              {transcription.translatedText}
            </p>
          ) : transcription.translationStatus === "pending" ? (
            <p className="feature-empty">Translation in progress…</p>
          ) : transcription.translationStatus === "failed" ? (
            <p className="feature-error">
              Translation failed
              {transcription.translationError ? `: ${transcription.translationError}` : ""}.
            </p>
          ) : null}
          <dl className="debug-kv-grid debug-kv-grid--compact">
            <div>
              <dt>Provider</dt>
              <dd>
                {transcription.provider}
                {transcription.model ? ` · ${transcription.model}` : ""}
              </dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{transcription.language ?? "—"}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatDateTime(transcription.completedAt)}</dd>
            </div>
            {transcription.latencyMs === null || transcription.latencyMs === undefined ? null : (
              <div>
                <dt>Latency</dt>
                <dd>{`${Math.round(transcription.latencyMs)} ms`}</dd>
              </div>
            )}
          </dl>
        </>
      )}
      {retranscribeError ? <p className="feature-error">{retranscribeError}</p> : null}
    </section>
  );
}

interface ModerationCardProps {
  readonly message: Message;
  readonly onRemoderate: () => void;
  readonly remoderating: boolean;
  readonly remoderateError: string | null;
}

function categoryRows(
  categories: Moderation["categories"],
): readonly { name: string; score: number }[] {
  if (!categories) return [];
  return Object.entries(categories)
    .map(([name, score]) => ({ name, score }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function ModerationCard({
  message,
  onRemoderate,
  remoderating,
  remoderateError,
}: ModerationCardProps): JSX.Element {
  const moderation = message.latestModeration ?? null;
  const transcription = message.latestTranscription ?? null;
  const canRun =
    transcription?.status === "succeeded" && (transcription.text?.trim().length ?? 0) > 0;
  const rows = categoryRows(moderation?.categories ?? null);
  return (
    <section className="feature-card feature-card--wide">
      <header className="feature-card-header">
        <h2>Moderation</h2>
        <div className="feature-card-header-actions">
          <ModerationBadge moderation={moderation} />
          <button type="button" onClick={onRemoderate} disabled={remoderating || !canRun}>
            {remoderating ? "Re-running…" : "Re-run moderation"}
          </button>
        </div>
      </header>
      {moderation === null ? (
        <p className="feature-empty">
          {canRun ? "No moderation yet." : "Waiting on transcription."}
        </p>
      ) : moderation.status === "pending" ? (
        <p className="feature-empty">Moderation in progress…</p>
      ) : moderation.status === "failed" ? (
        <p className="feature-error">
          Moderation failed{moderation.error ? `: ${moderation.error}` : ""}.
        </p>
      ) : (
        <>
          {moderation.reasonSummary ? (
            <p className="feature-transcript-body">{moderation.reasonSummary}</p>
          ) : null}
          <dl className="debug-kv-grid debug-kv-grid--compact">
            <div>
              <dt>Provider</dt>
              <dd>
                {moderation.provider}
                {moderation.model ? ` · ${moderation.model}` : ""}
              </dd>
            </div>
            <div>
              <dt>Recommendation</dt>
              <dd>{moderation.recommendation ?? "—"}</dd>
            </div>
            <div>
              <dt>Max score</dt>
              <dd>
                {moderation.maxScore === null || moderation.maxScore === undefined
                  ? "—"
                  : moderation.maxScore.toFixed(3)}
              </dd>
            </div>
            <div>
              <dt>Flagged</dt>
              <dd>
                {moderation.flagged === null || moderation.flagged === undefined
                  ? "—"
                  : moderation.flagged
                    ? "Yes"
                    : "No"}
              </dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatDateTime(moderation.completedAt)}</dd>
            </div>
          </dl>
          {rows.length === 0 ? null : (
            <table className="feature-table">
              <caption>Top categories</caption>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.score.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {remoderateError ? <p className="feature-error">{remoderateError}</p> : null}
    </section>
  );
}

interface HistoryCardProps {
  readonly transcriptions: readonly Transcription[];
}

function HistoryCard({ transcriptions }: HistoryCardProps): JSX.Element | null {
  if (transcriptions.length <= 1) return null;
  const prior = transcriptions.slice(1);
  return (
    <section className="feature-card feature-card--wide">
      <details>
        <summary>
          <h2>
            History ({prior.length} prior attempt{prior.length === 1 ? "" : "s"})
          </h2>
        </summary>
        <table className="feature-table">
          <caption>Transcription attempts</caption>
          <thead>
            <tr>
              <th>Created</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Snippet</th>
            </tr>
          </thead>
          <tbody>
            {prior.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDateTime(entry.createdAt)}</td>
                <td>
                  {entry.provider}
                  {entry.model ? ` · ${entry.model}` : ""}
                </td>
                <td>{entry.status}</td>
                <td>
                  {entry.text === null || entry.text === undefined || entry.text.length === 0
                    ? "—"
                    : entry.text.length > 80
                      ? `${entry.text.slice(0, 79)}…`
                      : entry.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function MessageDetail(): JSX.Element {
  const { id } = useParams({ from: "/messages/$id" });
  const message = useMessage(id);
  const questions = useQuestionsList();
  const transcriptions = useMessageTranscriptions(id);
  const retranscribe = useRetranscribeMessage();
  const remoderate = useRemoderateMessage();
  const [listened, setListened] = useState(() => readListened(id));
  const prompt = questions.data?.items.find(
    (question) => question.id === message.data?.questionId,
  )?.prompt;

  function toggle(value: boolean): void {
    setListened(value);
    writeListened(id, value);
  }

  const retranscribeError = retranscribe.error instanceof Error ? retranscribe.error.message : null;
  const remoderateError = remoderate.error instanceof Error ? remoderate.error.message : null;

  return (
    <GlassPanel title="Message detail" className="feature-screen messages-screen">
      <p className="screen-kicker">Message detail</p>
      <h1>Message playback</h1>
      {message.isLoading ? <FeatureSkeleton /> : null}
      {message.error ? <FeatureError message="Could not fetch this message." /> : null}
      {message.data === undefined ? null : (
        <>
          <section className="feature-card feature-card--wide">
            <h2>{prompt ?? "Unlinked booth recording"}</h2>
            <audio controls src={message.data.audio.url}>
              Message audio
            </audio>
            <dl className="debug-kv-grid debug-kv-grid--compact">
              <div>
                <dt>Status</dt>
                <dd>{message.data.status}</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{message.data.receivedAt ?? "Not received"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{message.data.createdAt}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>{message.data.audio.sha256}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>{message.data.notes ?? "None"}</dd>
              </div>
            </dl>
            <label className="feature-check">
              <input
                type="checkbox"
                checked={listened}
                onChange={(event) => toggle(event.currentTarget.checked)}
              />
              Mark as listened
            </label>
            <div className="debug-button-row">
              <a href={message.data.audio.url} download>
                Download audio
              </a>
              <Link to="/messages">Back to messages</Link>
            </div>
          </section>
          <TranscriptCard
            message={message.data}
            onRetranscribe={() => {
              retranscribe.mutate(id);
            }}
            retranscribing={retranscribe.isPending}
            retranscribeError={retranscribeError}
          />
          <ModerationCard
            message={message.data}
            onRemoderate={() => {
              remoderate.mutate(id);
            }}
            remoderating={remoderate.isPending}
            remoderateError={remoderateError}
          />
          {transcriptions.data ? <HistoryCard transcriptions={transcriptions.data.items} /> : null}
        </>
      )}
    </GlassPanel>
  );
}
