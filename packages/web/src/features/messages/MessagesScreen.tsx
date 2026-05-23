import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { Message, Moderation, Transcription } from "@telephone-booth-operator/shared";
import type { MessageRouteFilter } from "../../lib/navigation.js";
import { GlassPanel } from "../../components/booth/index.js";
import { useDeleteMessage, useDeleteMessages, useMessagesList, useQuestionsList } from "../../lib/api-client.js";
import { isMessageFilter } from "../../lib/navigation.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const filters: readonly MessageRouteFilter[] = ["all", "received", "uploading", "failed"];

function duration(ms: number | null): string {
  if (ms === null) return "Unknown";
  return `${Math.round(ms / 1000)}s`;
}

function date(value: string | null | undefined): string {
  return value === null || value === undefined ? "Not received" : new Date(value).toLocaleString();
}

const TRANSCRIPT_SNIPPET_CHARS = 80;

function transcriptSnippet(transcription: Transcription | null | undefined): string {
  if (!transcription) return "—";
  if (transcription.status === "pending") return "Transcribing…";
  if (transcription.status === "failed") return transcription.error ? "Transcription failed" : "Transcription failed";
  const text = transcription.text?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length === 0) return "Silence";
  return text.length <= TRANSCRIPT_SNIPPET_CHARS ? text : `${text.slice(0, TRANSCRIPT_SNIPPET_CHARS - 1)}…`;
}

interface ModerationBadge {
  readonly label: string;
  readonly variant: "approve" | "reject" | "review" | "pending" | "failed" | "none";
}

function moderationBadge(moderation: Moderation | null | undefined): ModerationBadge {
  if (!moderation) return { label: "—", variant: "none" };
  if (moderation.status === "pending") return { label: "Moderating…", variant: "pending" };
  if (moderation.status === "failed") return { label: "Moderation failed", variant: "failed" };
  if (moderation.recommendation === "approve") return { label: "Looks clean", variant: "approve" };
  if (moderation.recommendation === "reject") return { label: "Flagged", variant: "reject" };
  return { label: "Needs review", variant: "review" };
}

export function MessagesScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const status = isMessageFilter(search.status) ? search.status : "all";
  const messages = useMessagesList(status === "failed" ? "rejected" : status);
  const questions = useQuestionsList();
  const deleteMessage = useDeleteMessage();
  const deleteMessages = useDeleteMessages();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const rows = messages.data?.items ?? [];
  const promptById = useMemo(() => new Map((questions.data?.items ?? []).map((question) => [question.id, question.prompt])), [questions.data?.items]);

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <GlassPanel title="Message review queue" className="feature-screen messages-screen">
      <p className="screen-kicker">Digit 2</p>
      <h1>Messages</h1>
      <p>Review recordings from the booth, download keepers, and clear crossed lines.</p>
      <div className="feature-toolbar" role="toolbar" aria-label="Message filters">
        {filters.map((filter) => <button key={filter} type="button" aria-pressed={status === filter} onClick={() => void navigate({ to: "/messages", search: filter === "all" ? {} : { status: filter } })}>{filter}</button>)}
        <button type="button" disabled={selected.size === 0 || deleteMessages.isPending} onClick={() => void deleteMessages.mutateAsync([...selected]).then(() => setSelected(new Set()))}>Delete selected</button>
      </div>
      {messages.isLoading ? <FeatureSkeleton /> : null}
      {messages.error ? <FeatureError message="Could not load the message queue." /> : null}
      {!messages.isLoading && rows.length === 0 ? <FeatureEmpty title="No messages on the line">The booth has not sent recordings for this filter.</FeatureEmpty> : null}
      {rows.length === 0 ? null : (
        <div className="feature-table-wrap">
          <table className="feature-table">
            <caption>Message queue</caption>
            <thead><tr><th>Select</th><th>Received at</th><th>Duration</th><th>Question</th><th>Transcript</th><th>Moderation</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((message: Message) => {
                const badge = moderationBadge(message.latestModeration ?? null);
                return (
                  <tr key={message.id}>
                    <td><input aria-label={`Select message ${message.id}`} type="checkbox" checked={selected.has(message.id)} onChange={() => toggle(message.id)} /></td>
                    <td>{date(message.receivedAt ?? message.createdAt)}</td>
                    <td>{duration(message.audio.durationMs)}</td>
                    <td>{message.questionId === null || message.questionId === undefined ? "Unlinked" : promptById.get(message.questionId) ?? message.questionId}</td>
                    <td className="feature-row-transcript" title={message.latestTranscription?.text ?? undefined}>{transcriptSnippet(message.latestTranscription ?? null)}</td>
                    <td><span className={`feature-badge feature-badge--moderation-${badge.variant}`}>{badge.label}</span></td>
                    <td><span className={`feature-badge feature-badge--${message.status}`}>{message.status}</span></td>
                    <td className="feature-row-actions">
                      <Link to="/messages/$id" params={{ id: message.id }}>Play</Link>
                      <a href={message.audio.url} download>Download</a>
                      <button type="button" onClick={() => void deleteMessage.mutateAsync(message.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}
