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
import { useNow } from "../../hooks/useNow.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { MessageCard } from "./MessageCard.js";

// "Needs review" spans two backend statuses: `received` is a recording the AI
// worker has not claimed yet, `pending` is one with AI work in flight.
// `GET /v1/messages` only takes a single `status`, and an unfiltered fetch
// would be truncated to the newest N rows across *all* statuses — burying
// older unreviewed work behind a wall of approved messages. So the two
// statuses are fetched separately and merged here, letting the server truncate
// after filtering.
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

function receivedTime(message: Message): number {
  return Date.parse(message.receivedAt ?? message.createdAt);
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
  const now = useNow();
  const filter: MessageRouteFilter = isMessageFilter(search.status) ? search.status : "all";
  const needsReview = filter === "needs-review";
  const listed = useMessagesList(backendFilter(filter), { enabled: !needsReview });
  const received = useMessagesList("received", { enabled: needsReview });
  const pending = useMessagesList("pending", { enabled: needsReview });
  const questions = useQuestionsList();
  const deleteMessage = useDeleteMessage();
  const decideMessage = useDecideMessage();
  const retranscribe = useRetranscribeMessage();

  const queries = needsReview ? [received, pending] : [listed];
  const isLoading = queries.some((query) => query.isLoading);
  const loadError = queries.some((query) => query.error);

  const rows = useMemo(() => {
    if (!needsReview) return listed.data?.items ?? [];
    // A message can flip from `received` to `pending` between the two
    // requests and land in both responses, so dedupe before sorting.
    const merged = new Map<string, Message>();
    for (const item of [...(received.data?.items ?? []), ...(pending.data?.items ?? [])]) {
      merged.set(item.id, item);
    }
    return [...merged.values()].sort((a, b) => receivedTime(b) - receivedTime(a));
  }, [needsReview, listed.data?.items, received.data?.items, pending.data?.items]);

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
      {isLoading ? <FeatureSkeleton /> : null}
      {loadError ? <FeatureError message="Could not load the message queue." /> : null}
      {!isLoading && !loadError && rows.length === 0 ? (
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
                now={now}
                onDecide={(id, decision) => {
                  decideMessage.mutate({ id, input: { decision } });
                }}
                onRetranscribe={(id) => {
                  retranscribe.mutate(id);
                }}
                onDelete={(id) => {
                  deleteMessage.mutate(id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}
