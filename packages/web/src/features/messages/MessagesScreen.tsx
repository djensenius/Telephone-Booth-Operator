import type { JSX } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import type { Message, MessageStatus } from "@telephone-booth-operator/shared";
import type { MessageRouteFilter } from "../../lib/navigation.js";
import { GlassPanel } from "../../components/booth/index.js";
import {
  useDecideMessage,
  useDeleteMessage,
  useMessagesList,
  useQuestionsList,
  useRetranscribeMessage,
} from "../../lib/api-client.js";
import {
  MESSAGE_ROUTE_FILTERS,
  isMessageFilter,
  messageFilterLabel,
} from "../../lib/navigation.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { MessageCard } from "./MessageCard.js";

// Backend statuses that still want a human verdict. `received` is a recording
// the AI worker has not claimed yet; `pending` is one with AI work in flight.
// `GET /v1/messages` only takes a single `status`, so this filter fetches the
// unfiltered list and narrows here instead.
const NEEDS_REVIEW: readonly MessageStatus[] = ["received", "pending"];

const NEEDS_REVIEW_LIMIT = 200;

function backendFilter(filter: MessageRouteFilter): MessageStatus | "all" {
  switch (filter) {
    case "approved":
    case "rejected":
    case "uploading":
      return filter;
    default:
      return "all";
  }
}

function emptyCopy(filter: MessageRouteFilter): string {
  switch (filter) {
    case "needs-review":
      return "Nothing is waiting on a verdict right now.";
    case "approved":
      return "No messages have been approved yet.";
    case "rejected":
      return "No messages have been rejected yet.";
    case "uploading":
      return "No recordings are mid-upload.";
    default:
      return "The booth has not sent any recordings yet.";
  }
}

export function MessagesScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const filter: MessageRouteFilter = isMessageFilter(search.status) ? search.status : "all";
  const messages = useMessagesList(
    backendFilter(filter),
    filter === "needs-review" ? NEEDS_REVIEW_LIMIT : undefined,
  );
  const questions = useQuestionsList();
  const deleteMessage = useDeleteMessage();
  const decideMessage = useDecideMessage();
  const retranscribe = useRetranscribeMessage();

  const rows = useMemo(() => {
    const items = messages.data?.items ?? [];
    return filter === "needs-review"
      ? items.filter((message: Message) => NEEDS_REVIEW.includes(message.status))
      : items;
  }, [messages.data?.items, filter]);

  const promptById = useMemo(
    () => new Map((questions.data?.items ?? []).map((question) => [question.id, question.prompt])),
    [questions.data?.items],
  );

  const busy = deleteMessage.isPending || decideMessage.isPending || retranscribe.isPending;

  const actionError = [decideMessage.error, deleteMessage.error, retranscribe.error].find(
    (error): error is Error => error instanceof Error,
  );

  return (
    <GlassPanel title="Message review queue" className="feature-screen messages-screen">
      <p className="screen-kicker">Digit 2</p>
      <h1>Messages</h1>
      <p>Review recordings from the booth, approve or reject them, and clear crossed lines.</p>
      <div className="feature-toolbar" role="toolbar" aria-label="Message filters">
        {MESSAGE_ROUTE_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() =>
              void navigate({
                to: "/messages",
                search: option === "all" ? {} : { status: option },
              })
            }
          >
            {messageFilterLabel(option)}
          </button>
        ))}
      </div>
      {actionError ? <p className="feature-error">{actionError.message}</p> : null}
      {messages.isLoading ? <FeatureSkeleton /> : null}
      {messages.error ? <FeatureError message="Could not load the message queue." /> : null}
      {!messages.isLoading && !messages.error && rows.length === 0 ? (
        <FeatureEmpty title="No messages on the line">{emptyCopy(filter)}</FeatureEmpty>
      ) : null}
      {rows.length === 0 ? null : (
        <ul className="message-card-list" aria-label="Message queue">
          {rows.map((message: Message) => (
            <li key={message.id}>
              <MessageCard
                message={message}
                prompt={
                  message.questionId === null || message.questionId === undefined
                    ? null
                    : (promptById.get(message.questionId) ?? message.questionId)
                }
                busy={busy}
                onDecide={(id, decision) => {
                  decideMessage.mutate({ id, input: { decision } });
                }}
                onRetranscribe={(id) => {
                  retranscribe.mutate(id);
                }}
                onDelete={(id) => {
                  void deleteMessage.mutateAsync(id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}
