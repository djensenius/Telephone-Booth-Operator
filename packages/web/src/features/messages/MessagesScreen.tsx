import type { JSX } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import type { Message, MessageStatus } from "@telephone-booth-operator/shared";
import type { MessageRouteFilter } from "../../lib/navigation.js";
import { GlassPanel } from "../../components/booth/index.js";
import {
  useMessagesList,
  useQuestionsByIds,
  useMessageProcessingSummary,
} from "../../lib/api-client.js";
import {
  InstallationScopePicker,
  parseInstallationScopeParam,
  useIsInstallationFrozen,
  useScopeIsFrozen,
} from "../installations/InstallationScopePicker.js";
import {
  MESSAGE_ROUTE_FILTERS,
  isMessageFilter,
  messageFilterLabel,
} from "../../lib/navigation.js";
import { MessageCollection } from "./MessageCollection.js";

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
  const filter: MessageRouteFilter = isMessageFilter(search.status) ? search.status : "all";
  const scope = parseInstallationScopeParam(search.installationId);
  // Browsing a past era is read-only: its counters were frozen when it ended,
  // and the API refuses a decision or a delete against it.
  const frozen = useScopeIsFrozen(scope);
  // `installationId=all` spans open and closed eras at once, so the page as a
  // whole is not frozen but individual rows are.
  const installationIsFrozen = useIsInstallationFrozen();
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
  const processingSummary = useMessageProcessingSummary();

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

  return (
    <GlassPanel title="Message review queue" className="feature-screen messages-screen">
      <p className="screen-kicker">Digit 2</p>
      <h1>Messages</h1>
      <p>Review recordings from the booth, approve or reject them, and clear crossed lines.</p>
      {scope === undefined && processingSummary.data ? (
        <p className="settings-status" role="status">
          On-device processing: {processingSummary.data.queued} queued,{" "}
          {processingSummary.data.leased} leased, {processingSummary.data.terminal} terminal.
        </p>
      ) : null}
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
      <MessageCollection
        rows={rows}
        promptById={promptById}
        isLoading={isLoading}
        loadError={loadError}
        loadErrorMessage="Could not load the message queue."
        emptyTitle="No messages on the line"
        emptyCopy={emptyCopy(filter)}
        ariaLabel="Message queue"
        isFrozen={(message) => frozen || installationIsFrozen(message.installationId)}
      />
    </GlassPanel>
  );
}
