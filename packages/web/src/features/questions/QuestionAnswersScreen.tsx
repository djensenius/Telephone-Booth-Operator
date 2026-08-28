import type { JSX } from "react";
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import type { Message } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useQuestionMessages, useQuestionsByIds } from "../../lib/api-client.js";
import { useIsInstallationFrozen } from "../installations/InstallationScopePicker.js";
import { MessageCollection } from "../messages/MessageCollection.js";

export function QuestionAnswersScreen({
  questionId,
}: {
  readonly questionId: string;
}): JSX.Element {
  const answers = useQuestionMessages(questionId);
  const questions = useQuestionsByIds([questionId]);
  const installationIsFrozen = useIsInstallationFrozen();
  const question = questions.data?.find((item) => item.id === questionId);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const messages: Message[] = [];
    for (const page of answers.data?.pages ?? []) {
      for (const message of page.items) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        messages.push(message);
      }
    }
    return messages;
  }, [answers.data?.pages]);
  const promptById = useMemo(
    () => new Map(question ? [[question.id, question.prompt]] : []),
    [question],
  );

  return (
    <GlassPanel title="Question answers" className="feature-screen question-answers-screen">
      <p className="screen-kicker">Question responses</p>
      <h1>Answers</h1>
      <p className="question-answers__prompt">
        {question?.prompt ?? (questions.isLoading ? "Loading question…" : "Question unavailable")}
      </p>
      <p>Review every recording linked to this prompt, including historical responses.</p>
      <Link to="/questions">Back to questions</Link>
      <MessageCollection
        rows={rows}
        promptById={promptById}
        isLoading={answers.isLoading || questions.isLoading}
        loadError={answers.error !== null || questions.error !== null}
        loadErrorMessage="Could not load the answers to this question."
        emptyTitle="No answers on the line"
        emptyCopy="No recordings have been linked to this question yet."
        ariaLabel="Answers to this question"
        isFrozen={(message) => installationIsFrozen(message.installationId)}
        footer={
          answers.hasNextPage ? (
            <div className="feature-actions question-answers__pagination">
              <button
                className="feature-primary-button"
                type="button"
                disabled={answers.isFetchingNextPage}
                onClick={() => void answers.fetchNextPage()}
              >
                {answers.isFetchingNextPage ? "Loading…" : "Load more answers"}
              </button>
            </div>
          ) : null
        }
      />
    </GlassPanel>
  );
}
