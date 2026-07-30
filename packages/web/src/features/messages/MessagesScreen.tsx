import type { JSX } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, MessageStatus } from "@telephone-booth-operator/shared";
import type { MessageRouteFilter } from "../../lib/navigation.js";
import { GlassPanel } from "../../components/booth/index.js";
import {
  useDecideMessage,
  useDeleteMessage,
  useMessagesList,
  useQuestionsByIds,
  useRetranscribeMessage,
} from "../../lib/api-client.js";
import {
  InstallationScopePicker,
  parseInstallationScopeParam,
} from "../installations/InstallationScopePicker.js";
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

// API failures arrive as machine codes (`not_found`, `conflict`, …), which are
// no help to an operator, so map the ones an action can realistically hit.
const ACTION_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "That message is no longer on file — refresh the queue.",
  conflict: "That message changed while you were working on it. Refresh and try again.",
  forbidden: "Your account is not allowed to do that.",
  unauthorized: "Your session expired. Sign in again.",
};

function actionMessage(error: Error): string {
  return ACTION_MESSAGES[error.message] ?? "That action could not be completed. Try again.";
}

export function MessagesScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // Focus moves into the confirmation and returns to the card's Delete button
  // when it closes, so the dialog is announced and keyboard users keep place.
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const navigate = useNavigate();
  const now = useNow();
  const filter: MessageRouteFilter = isMessageFilter(search.status) ? search.status : "all";
  const scope = parseInstallationScopeParam(search.installationId);
  const needsReview = filter === "needs-review";
  const listed = useMessagesList(backendFilter(filter), {
    enabled: !needsReview,
    ...(scope === undefined ? {} : { installationId: scope }),
  });
  const received = useMessagesList("received", {
    enabled: needsReview,
    ...(scope === undefined ? {} : { installationId: scope }),
  });
  const pending = useMessagesList("pending", {
    enabled: needsReview,
    ...(scope === undefined ? {} : { installationId: scope }),
  });
  const questionIds = useMemo(() => {
    const rowsForIds = needsReview
      ? [...(received.data?.items ?? []), ...(pending.data?.items ?? [])]
      : (listed.data?.items ?? []);
    const ids = new Set<string>();
    for (const item of rowsForIds) {
      if (typeof item.questionId === "string" && item.questionId.length > 0) {
        ids.add(item.questionId);
      }
    }
    return Array.from(ids);
  }, [needsReview, listed.data?.items, received.data?.items, pending.data?.items]);
  const questions = useQuestionsByIds(questionIds);
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
    () => new Map((questions.data ?? []).map((question) => [question.id, question.prompt])),
    [questions.data],
  );

  const closeConfirm = useCallback(() => {
    setDeleteId(null);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (deleteId !== null) confirmRef.current?.focus();
  }, [deleteId]);

  // Every card with work in flight, not just the latest one: a synchronous
  // re-transcription can take minutes, so it must neither freeze the rest of
  // the queue nor stop marking its own card busy once another action starts.
  const clearBusy = useCallback((id: string) => {
    setBusyIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  // A delete failure is reported inside the confirmation while it is open, so
  // the focused operator sees it without looking behind the backdrop.
  const actionError = [
    decideMessage.error,
    deleteId === null ? deleteMessage.error : null,
    retranscribe.error,
  ].find((error): error is Error => error instanceof Error);

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
                search: {
                  ...(option === "all" ? {} : { status: option }),
                  ...(scope === undefined ? {} : { installationId: scope }),
                },
              })
            }
          >
            {messageFilterLabel(option)}
          </button>
        ))}
      </div>
      <InstallationScopePicker
        scope={scope}
        onChange={(next) =>
          void navigate({
            to: "/messages",
            search: {
              ...(filter === "all" ? {} : { status: filter }),
              ...(next === undefined ? {} : { installationId: next }),
            },
            replace: true,
          })
        }
      />
      {actionError ? (
        <p className="feature-error" role="alert">
          {actionMessage(actionError)}
        </p>
      ) : null}
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
                busy={busyIds.has(message.id)}
                now={now}
                onDecide={(id, decision) => {
                  setBusyIds((previous) => new Set(previous).add(id));
                  decideMessage.mutate(
                    { id, input: { decision } },
                    { onSettled: () => clearBusy(id) },
                  );
                }}
                onRetranscribe={(id) => {
                  setBusyIds((previous) => new Set(previous).add(id));
                  retranscribe.mutate(id, { onSettled: () => clearBusy(id) });
                }}
                onDelete={(id, trigger) => {
                  returnFocusRef.current = trigger;
                  setDeleteId(id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {deleteId === null ? null : (
        <div
          className="feature-dialog-backdrop"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === "Escape") closeConfirm();
          }}
        >
          <section
            className="feature-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-message-heading"
          >
            <h2 id="delete-message-heading">Delete this recording?</h2>
            <p>The audio and its transcript are removed for good. This cannot be undone.</p>
            {deleteMessage.error instanceof Error ? (
              <p className="feature-error" role="alert">
                {actionMessage(deleteMessage.error)}
              </p>
            ) : null}
            <div className="debug-button-row">
              <button
                ref={confirmRef}
                type="button"
                disabled={deleteMessage.isPending}
                onClick={() => {
                  setBusyIds((previous) => new Set(previous).add(deleteId));
                  deleteMessage.mutate(deleteId, {
                    onSuccess: closeConfirm,
                    onSettled: () => clearBusy(deleteId),
                  });
                }}
              >
                Confirm delete
              </button>
              <button type="button" disabled={deleteMessage.isPending} onClick={closeConfirm}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}
    </GlassPanel>
  );
}
