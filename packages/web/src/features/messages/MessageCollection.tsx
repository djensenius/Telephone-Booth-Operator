import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "@telephone-booth-operator/shared";
import {
  useDecideMessage,
  useDeleteMessage,
  useRetranscribeMessage,
} from "../../lib/api-client.js";
import { useNow } from "../../hooks/useNow.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { MessageCard } from "./MessageCard.js";

const ACTION_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "That message is no longer on file — refresh the queue.",
  conflict: "That message changed while you were working on it. Refresh and try again.",
  forbidden: "Your account is not allowed to do that.",
  unauthorized: "Your session expired. Sign in again.",
};

function actionMessage(error: Error): string {
  return ACTION_MESSAGES[error.message] ?? "That action could not be completed. Try again.";
}

export function MessageCollection({
  rows,
  promptById,
  isLoading,
  loadError,
  loadErrorMessage,
  emptyTitle,
  emptyCopy,
  ariaLabel,
  isFrozen,
  footer = null,
}: {
  readonly rows: readonly Message[];
  readonly promptById: ReadonlyMap<string, string>;
  readonly isLoading: boolean;
  readonly loadError: boolean;
  readonly loadErrorMessage: string;
  readonly emptyTitle: string;
  readonly emptyCopy: string;
  readonly ariaLabel: string;
  readonly isFrozen: (message: Message) => boolean;
  readonly footer?: JSX.Element | null;
}): JSX.Element {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const now = useNow();
  const deleteMessage = useDeleteMessage();
  const decideMessage = useDecideMessage();
  const retranscribe = useRetranscribeMessage();

  const closeConfirm = useCallback(() => {
    setDeleteId(null);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (deleteId !== null) confirmRef.current?.focus();
  }, [deleteId]);

  const clearBusy = useCallback((id: string) => {
    setBusyIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  const actionError = [
    decideMessage.error,
    deleteId === null ? deleteMessage.error : null,
    retranscribe.error,
  ].find((error): error is Error => error instanceof Error);

  return (
    <>
      {actionError ? (
        <p className="feature-error" role="alert">
          {actionMessage(actionError)}
        </p>
      ) : null}
      {isLoading ? <FeatureSkeleton /> : null}
      {loadError ? <FeatureError message={loadErrorMessage} /> : null}
      {!isLoading && !loadError && rows.length === 0 ? (
        <FeatureEmpty title={emptyTitle}>{emptyCopy}</FeatureEmpty>
      ) : null}
      {rows.length === 0 ? null : (
        <ul className="message-card-list" aria-label={ariaLabel}>
          {rows.map((message) => (
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
                frozen={isFrozen(message)}
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
      {rows.length === 0 ? null : footer}
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
    </>
  );
}
