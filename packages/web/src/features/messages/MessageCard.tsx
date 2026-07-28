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
  readonly onDelete: (id: string) => void;
}

export function MessageCard({
  message,
  prompt,
  busy,
  now,
  onDecide,
  onRetranscribe,
  onDelete,
}: MessageCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const receivedAt = message.receivedAt ?? message.createdAt;
  const relative = relativeTime(receivedAt, now) ?? "Not received";
  const absolute = absoluteTime(receivedAt) ?? "Not received";
  const length = durationLabel(message.audio.durationMs);
  const badge = moderationBadge(message.latestModeration ?? null);
  const transcription = message.latestTranscription ?? null;
  const status = transcriptionStatusView(transcription);
  const text = transcriptText(transcription);
  const { snippet, truncated } =
    text === null ? { snippet: "", truncated: false } : transcriptSnippet(text);
  // `uploading` messages have no finished recording to judge yet — the API
  // rejects a decision on them, so the buttons stay disabled here too.
  const decidable = message.status !== "uploading" && !busy;

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

      <audio className="message-card__audio" controls preload="none" src={message.audio.url}>
        Message audio
      </audio>

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
        <Link to="/messages/$id" params={{ id: message.id }}>
          Open
        </Link>
        {status.canRetry && message.status !== "uploading" ? (
          <button type="button" disabled={busy} onClick={() => onRetranscribe(message.id)}>
            Re-run transcription
          </button>
        ) : null}
        <a href={message.audio.url} download>
          Download
        </a>
        <button type="button" disabled={busy} onClick={() => onDelete(message.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}
