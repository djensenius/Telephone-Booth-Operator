import type { JSX } from "react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Message, Moderation } from "@telephone-booth-operator/shared";
import { absoluteTime, durationLabel, relativeTime } from "../../lib/time-format.js";
import {
  transcriptSnippet,
  transcriptText,
  transcriptionStatusView,
} from "./transcription-status.js";

export interface ModerationBadgeView {
  readonly label: string;
  readonly variant: "approve" | "reject" | "review" | "pending" | "failed" | "none";
}

export function moderationBadge(moderation: Moderation | null | undefined): ModerationBadgeView {
  if (!moderation) return { label: "No AI verdict", variant: "none" };
  if (moderation.status === "pending") return { label: "Moderating…", variant: "pending" };
  if (moderation.status === "failed") return { label: "Moderation failed", variant: "failed" };
  if (moderation.recommendation === "approve") return { label: "Looks clean", variant: "approve" };
  if (moderation.recommendation === "reject") return { label: "Flagged", variant: "reject" };
  return { label: "Needs review", variant: "review" };
}

export interface MessageCardProps {
  readonly message: Message;
  readonly prompt: string | null;
  readonly busy: boolean;
  readonly now: number;
  readonly onDecide: (id: string, decision: "approve" | "reject") => void;
  readonly onRetranscribe: (id: string) => void;
  readonly onDelete: (id: string, trigger: HTMLButtonElement) => void;
  // An ended era's counters are frozen, so its recordings are read-only: the
  // API refuses a decision or a delete against them and the card should not
  // offer either.
  readonly frozen?: boolean;
}

export function MessageCard({
  message,
  prompt,
  busy,
  now,
  onDecide,
  onRetranscribe,
  onDelete,
  frozen = false,
}: MessageCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const receivedAt = message.receivedAt ?? message.createdAt;
  const relative = relativeTime(receivedAt, now) ?? "Not received";
  const absolute = absoluteTime(receivedAt) ?? "Not received";
  const length = durationLabel(message.audio.durationMs);
  const transcription = message.latestTranscription ?? null;
  // A re-run creates a new transcription before moderation catches up, so the
  // previous verdict would otherwise be shown against different words.
  const moderation = message.latestModeration ?? null;
  const badge = moderationBadge(
    moderation !== null && transcription !== null && moderation.transcriptionId !== transcription.id
      ? null
      : moderation,
  );
  const status = transcriptionStatusView(transcription);
  const text = transcriptText(transcription);
  const { snippet, truncated } =
    text === null ? { snippet: "", truncated: false } : transcriptSnippet(text);
  // `uploading` messages have no finished recording to judge yet — the API
  // rejects a decision on them, so the buttons stay disabled here too.
  const uploading = message.status === "uploading";
  const decidable = !uploading && !busy;

  return (
    <article className="message-card" aria-label={`Message received ${absolute}`}>
      <header className="message-card__header">
        <time className="message-card__time" dateTime={receivedAt} title={absolute}>
          {relative}
        </time>
        <span className={`feature-badge feature-badge--${message.status}`}>{message.status}</span>
        <span className={`feature-badge feature-badge--moderation-${badge.variant}`}>
          {badge.label}
        </span>
        {length === null ? null : <span className="message-card__duration">{length}</span>}
      </header>

      <h2 className="message-card__prompt">{prompt ?? "Unlinked booth recording"}</h2>

      {uploading ? (
        <p className="message-card__status message-card__status--pending">
          Upload in progress — playback is available once the booth finishes sending.
        </p>
      ) : (
        <audio className="message-card__audio" controls preload="none" src={message.audio.url}>
          Message audio
        </audio>
      )}

      <div className="message-card__transcript">
        {text === null ? (
          <p className={`message-card__status message-card__status--${status.tone}`}>
            {status.label}
            {status.detail === null ? null : (
              <span className="message-card__status-detail">{status.detail}</span>
            )}
          </p>
        ) : (
          <>
            <p className="message-card__text">{expanded ? text : snippet}</p>
            {truncated ? (
              <button
                type="button"
                className="message-card__expand"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : "Show full transcript"}
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="message-card__actions">
        {frozen ? null : (
          <>
            <button
              type="button"
              className="feature-button feature-button--approve"
              disabled={!decidable}
              onClick={() => onDecide(message.id, "approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="feature-button feature-button--reject"
              disabled={!decidable}
              onClick={() => onDecide(message.id, "reject")}
            >
              Reject
            </button>
          </>
        )}
        <Link to="/messages/$id" params={{ id: message.id }}>
          Open
        </Link>
        {status.canRetry && !uploading && !frozen ? (
          <button type="button" disabled={busy} onClick={() => onRetranscribe(message.id)}>
            Re-run transcription
          </button>
        ) : null}
        {uploading ? null : (
          <a href={message.audio.url} download>
            Download
          </a>
        )}
        {frozen ? (
          <span className="message-card__frozen">Archived era — read-only</span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={(event) => onDelete(message.id, event.currentTarget)}
          >
            Delete
          </button>
        )}
      </div>
    </article>
  );
}
