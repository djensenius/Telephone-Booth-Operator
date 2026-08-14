import type { JSX } from "react";
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { Message, Moderation, Transcription } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  useDecideMessage,
  useMessage,
  useMessageTranscriptions,
  useQuestionsByIds,
  useRemoderateMessage,
  useRetranscribeMessage,
} from "../../lib/api-client.js";
import { FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { useIsInstallationFrozen } from "../installations/InstallationScopePicker.js";
import { transcriptionStatusView } from "./transcription-status.js";
import { absoluteTime, relativeTime } from "../../lib/time-format.js";
import { useNow } from "../../hooks/useNow.js";

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
  return absoluteTime(value) ?? "—";
}

// "3h ago (12/03/2026, 18:04)" — relative reads faster, absolute stays exact.
function formatMoment(value: string | null | undefined, now: number): string {
  const absolute = absoluteTime(value);
  if (absolute === null) return "—";
  const relative = relativeTime(value, now);
  return relative === null ? absolute : `${relative} (${absolute})`;
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
  const status = transcriptionStatusView(transcription);
  return (
    <section className="feature-card feature-card--wide">
      <header className="feature-card-header">
        <h2>Transcript</h2>
        <button
          type="button"
          onClick={onRetranscribe}
          disabled={retranscribing || !status.canRetry || message.status === "uploading"}
        >
          {retranscribing ? "Re-running…" : "Re-run transcription"}
        </button>
      </header>
      {transcription === null ? (
        <p className="feature-empty">No transcription yet. Run one to populate moderation.</p>
      ) : transcription.status === "pending" ? (
        <p className="feature-empty">
          {status.label}
          {status.detail === null ? "" : ` — ${status.detail}`}
        </p>
      ) : transcription.status === "failed" ? (
        <p className="feature-error">
          {status.label}
          {status.detail === null ? "." : `: ${status.detail}.`}
        </p>
      ) : status.tone === "none" ? (
        <p className="feature-empty">Silence — the recording has no speech.</p>
      ) : (
        <>
          <p className="feature-transcript-body">{transcription.text ?? ""}</p>
          {transcription.translationStatus === "succeeded" &&
          typeof transcription.translatedText === "string" &&
          transcription.translatedText.trim().length > 0 ? (
            <p className="feature-transcript-body feature-transcript-body--translated">
              <span className="feature-transcript-label">
                Translated from {transcription.language ?? "unknown"}
                {transcription.translatedLanguage ? ` to ${transcription.translatedLanguage}` : ""}
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

interface DecisionCardProps {
  readonly message: Message;
  readonly onDecide: (decision: "approve" | "reject", notes: string) => void;
  readonly deciding: boolean;
  readonly decideError: string | null;
  // The recording belongs to an era that has ended. Its counters were frozen
  // on the way out, so the API refuses a decision against it.
  readonly frozen: boolean;
}

// Human moderation control. The AI moderation result is shown here only as an
// advisory suggestion; approving or rejecting a message is always an explicit
// operator action. "uploading" messages have no content to judge yet.
function DecisionCard({
  message,
  onDecide,
  deciding,
  decideError,
  frozen,
}: DecisionCardProps): JSX.Element {
  const [notes, setNotes] = useState("");
  const moderation = message.latestModeration ?? null;
  const { label, variant } = moderationVariant(moderation);
  const decidable = message.status !== "uploading" && !frozen;
  const alreadyDecided = message.status === "approved" || message.status === "rejected";
  return (
    <section className="feature-card feature-card--wide">
      <header className="feature-card-header">
        <h2>Decision</h2>
        <span className={`feature-badge feature-badge--${message.status}`}>{message.status}</span>
      </header>
      <p className="feature-empty">
        AI suggestion (advisory only):{" "}
        <span className={`feature-badge feature-badge--moderation-${variant}`}>{label}</span>
      </p>
      {alreadyDecided ? (
        <p className="feature-transcript-body">
          This message is currently <strong>{message.status}</strong>
          {message.decidedAt ? ` (decided ${formatDateTime(message.decidedAt)})` : ""}. You can
          change the decision below.
        </p>
      ) : null}
      <label className="feature-field">
        <span>Notes (optional)</span>
        <textarea
          value={notes}
          maxLength={2000}
          rows={2}
          onChange={(event) => setNotes(event.currentTarget.value)}
          disabled={!decidable || deciding}
          placeholder="Why you approved or rejected this message"
        />
      </label>
      <div className="debug-button-row">
        <button
          type="button"
          className="feature-button feature-button--approve"
          onClick={() => onDecide("approve", notes)}
          disabled={!decidable || deciding}
        >
          {deciding ? "Saving…" : "Approve"}
        </button>
        <button
          type="button"
          className="feature-button feature-button--reject"
          onClick={() => onDecide("reject", notes)}
          disabled={!decidable || deciding}
        >
          {deciding ? "Saving…" : "Reject"}
        </button>
      </div>
      {frozen ? (
        <p className="feature-empty">Archived era — read-only.</p>
      ) : !decidable ? (
        <p className="feature-empty">Waiting for the recording to finish uploading.</p>
      ) : null}
      {decideError ? <p className="feature-error">{decideError}</p> : null}
    </section>
  );
}

export function MessageDetail(): JSX.Element {
  const { id } = useParams({ from: "/messages/$id" });
  const now = useNow();
  const message = useMessage(id);
  // A message can belong to any era (this route has no scope picker of its
  // own), and questions are archived at rollover. Look up exactly this
  // message's question by id so the prompt resolves regardless of era or
  // archival status.
  const questionId = message.data?.questionId ?? null;
  const questions = useQuestionsByIds(questionId === null ? [] : [questionId]);
  const transcriptions = useMessageTranscriptions(id);
  const retranscribe = useRetranscribeMessage();
  const remoderate = useRemoderateMessage();
  const decide = useDecideMessage();
  const [listened, setListened] = useState(() => readListened(id));
  const prompt = questions.data?.find((question) => question.id === questionId)?.prompt;
  // This route has no scope picker: a message opened from a cross-era list can
  // belong to a closed installation, whose decisions the API refuses.
  const installationIsFrozen = useIsInstallationFrozen();

  function toggle(value: boolean): void {
    setListened(value);
    writeListened(id, value);
  }

  const retranscribeError = retranscribe.error instanceof Error ? retranscribe.error.message : null;
  const remoderateError = remoderate.error instanceof Error ? remoderate.error.message : null;
  const decideError = decide.error instanceof Error ? decide.error.message : null;

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
                <dd>
                  {message.data.receivedAt === null || message.data.receivedAt === undefined
                    ? "Not received"
                    : formatMoment(message.data.receivedAt, now)}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatMoment(message.data.createdAt, now)}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>{message.data.audio.sha256}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>{message.data.notes ?? "None"}</dd>
              </div>
              <div>
                <dt>Device review</dt>
                <dd>
                  {message.data.reviewClassification === "likely_hangup"
                    ? "Likely hangup"
                    : message.data.reviewClassification === "unclear"
                      ? "Unclear recording"
                      : "Not classified"}
                </dd>
              </div>
              {message.data.reviewRecommendation === null ||
              message.data.reviewRecommendation === undefined ? null : (
                <div>
                  <dt>Device recommendation</dt>
                  <dd>
                    {message.data.reviewRecommendation === "delete"
                      ? "Delete (advisory; never automatic)"
                      : "Review"}
                  </dd>
                </div>
              )}
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
          <DecisionCard
            message={message.data}
            onDecide={(decision, notes) => {
              decide.mutate({
                id,
                input: { decision, ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}) },
              });
            }}
            deciding={decide.isPending}
            decideError={decideError}
            frozen={installationIsFrozen(message.data.installationId)}
          />
          {transcriptions.data ? <HistoryCard transcriptions={transcriptions.data.items} /> : null}
        </>
      )}
    </GlassPanel>
  );
}
