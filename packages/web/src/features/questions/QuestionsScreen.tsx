import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { GlassPanel } from "../../components/booth/index.js";
import {
  AUDIO_UPLOAD_ACCEPT,
  audioUploadContentType,
  sha256Hex,
  uploadBlobToSas,
  uploads,
  useActivateQuestion,
  useCreateQuestion,
  useDeactivateQuestion,
  useDeleteQuestion,
  useQuestionsList,
  useUpdateQuestion,
} from "../../lib/api-client.js";
import { durationLabel } from "../../lib/time-format.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { useCurrentUser } from "../auth/useCurrentUser.js";
import type { Question, QuestionStatus } from "@telephone-booth-operator/shared";

const QUESTION_FILTERS: readonly (QuestionStatus | "all")[] = [
  "all",
  "draft",
  "active",
  "archived",
];

function date(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function QuestionAudio({
  url,
  durationMs,
}: {
  readonly url: string;
  readonly durationMs: number | null;
}): JSX.Element {
  const [measuredDurationMs, setMeasuredDurationMs] = useState<number | null>(durationMs);
  const label = durationLabel(measuredDurationMs);

  return (
    <div className="question-card__audio">
      <audio
        controls
        preload="metadata"
        src={url}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds) && seconds > 0) {
            setMeasuredDurationMs(Math.round(seconds * 1000));
          }
        }}
      >
        Question audio
      </audio>
      <span>{label ?? "Reading length…"}</span>
    </div>
  );
}

export function NewQuestionDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element | null {
  const createQuestion = useCreateQuestion();
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (file === null) return;
    setUploadError(null);
    try {
      setStatus("Reserving a clean line for the audio…");
      const sha256 = await sha256Hex(file);
      const contentType = audioUploadContentType(file);
      const slot = await uploads.sas({
        kind: "question-audio",
        sha256,
        sizeBytes: file.size,
        contentType,
      });
      if (slot.audioFileId === undefined)
        throw new Error("Upload slot did not include an audio file id.");
      setStatus("Sending the question audio up the wire…");
      await uploadBlobToSas(slot.uploadUrl, file, contentType);
      setStatus("Filing the prompt card…");
      await createQuestion.mutateAsync({ prompt, audioFileId: slot.audioFileId });
      setPrompt("");
      setFile(null);
      setStatus("");
      onClose();
    } catch {
      setStatus("");
      setUploadError("The question could not be filed.");
    }
  }

  return (
    <div className="feature-dialog-backdrop" role="presentation">
      <section
        className="feature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-question-heading"
      >
        <h2 id="new-question-heading">New question</h2>
        <form className="feature-form" onSubmit={(event) => void submit(event)}>
          <label>
            Prompt
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              maxLength={280}
              required
            />
          </label>
          <label>
            Audio file
            <input
              type="file"
              accept={AUDIO_UPLOAD_ACCEPT}
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              required
            />
          </label>
          {createQuestion.error || uploadError !== null ? (
            <FeatureError message={uploadError ?? "The question could not be filed."} />
          ) : null}
          <p aria-live="polite">{status}</p>
          <div className="debug-button-row">
            <button
              type="submit"
              disabled={createQuestion.isPending || prompt.trim().length === 0 || file === null}
            >
              Place a call
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function EditQuestionDialog({
  question,
  onClose,
}: {
  readonly question: Question | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  const updateQuestion = useUpdateQuestion();
  const [prompt, setPrompt] = useState(question?.prompt ?? "");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (question !== null) promptRef.current?.focus();
  }, [question]);

  if (question === null) return null;
  const questionId = question.id;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    updateQuestion.mutate(
      { id: questionId, input: { prompt: prompt.trim() } },
      { onSuccess: onClose },
    );
  }

  return (
    <div
      className="feature-dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !updateQuestion.isPending) onClose();
      }}
    >
      <section
        className="feature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-question-heading"
      >
        <h2 id="edit-question-heading">Edit question prompt</h2>
        <form className="feature-form" onSubmit={submit}>
          <label>
            Prompt
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              maxLength={280}
              rows={4}
              required
            />
          </label>
          {updateQuestion.error ? (
            <FeatureError message="The question prompt could not be updated." />
          ) : null}
          <div className="debug-button-row">
            <button type="submit" disabled={updateQuestion.isPending || prompt.trim().length === 0}>
              Save prompt
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function QuestionsScreen({
  startNew = false,
}: { readonly startNew?: boolean } = {}): JSX.Element {
  const { user } = useCurrentUser();
  const isAdmin = user?.isAdmin ?? false;
  const [filter, setFilter] = useState<QuestionStatus | "all">("all");
  const questions = useQuestionsList(filter);
  const deleteQuestion = useDeleteQuestion();
  const activateQuestion = useActivateQuestion();
  const deactivateQuestion = useDeactivateQuestion();
  const [dialogOpen, setDialogOpen] = useState(startNew && isAdmin);
  const [editQuestion, setEditQuestion] = useState<Question | null>(null);
  const editReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const rows = questions.data?.items ?? [];
  const closeEditDialog = useCallback(() => {
    setEditQuestion(null);
    editReturnFocusRef.current?.focus();
    editReturnFocusRef.current = null;
  }, []);

  return (
    <GlassPanel title="Question library" className="feature-screen questions-screen">
      <p className="screen-kicker">Digit 3</p>
      <h1>Questions</h1>
      <p>Keep the booth supplied with prompt cards and their matching audio.</p>
      <div className="question-library-controls">
        <div className="feature-toolbar" role="toolbar" aria-label="Question filters">
          {QUESTION_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {isAdmin ? (
          <button
            className="feature-primary-button"
            type="button"
            onClick={() => setDialogOpen(true)}
          >
            New question
          </button>
        ) : null}
      </div>
      {!isAdmin ? (
        <p className="feature-note" role="note">
          You have read-only access to the question library. Ask an operator admin to add, edit, or
          retire questions.
        </p>
      ) : null}
      {questions.isLoading ? <FeatureSkeleton /> : null}
      {questions.error ? <FeatureError message="Could not load the question library." /> : null}
      {!questions.isLoading && rows.length === 0 ? (
        <FeatureEmpty title="No questions on the line">
          Place a call to add the first booth prompt.
        </FeatureEmpty>
      ) : null}
      {rows.length === 0 ? null : (
        <ul className="question-card-list" aria-label="Question library">
          {rows.map((question) => (
            <li className="question-card" key={question.id}>
              <div className="question-card__heading">
                <span className={`question-status question-status-${question.status}`}>
                  {question.status}
                </span>
                <span className="question-card__date">Added {date(question.createdAt)}</span>
              </div>
              <h2>{question.prompt}</h2>
              <QuestionAudio url={question.audio.url} durationMs={question.audio.durationMs} />
              {isAdmin ? (
                <div className="question-card__actions">
                  {question.status === "archived" ? (
                    <span className="question-card__archived-note">
                      Archived questions are read-only.
                    </span>
                  ) : question.status === "active" ? (
                    <button
                      type="button"
                      disabled={deactivateQuestion.isPending}
                      onClick={() => void deactivateQuestion.mutateAsync(question.id)}
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={activateQuestion.isPending}
                      onClick={() => void activateQuestion.mutateAsync(question.id)}
                    >
                      Activate
                    </button>
                  )}
                  {question.status === "archived" ? null : (
                    <>
                      <button
                        type="button"
                        onClick={(event) => {
                          editReturnFocusRef.current = event.currentTarget;
                          setEditQuestion(question);
                        }}
                      >
                        Edit prompt
                      </button>
                      <button type="button" onClick={() => setDeleteId(question.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <NewQuestionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      ) : null}
      {isAdmin ? (
        <EditQuestionDialog
          key={editQuestion?.id}
          question={editQuestion}
          onClose={closeEditDialog}
        />
      ) : null}
      {deleteId === null || !isAdmin ? null : (
        <div className="feature-dialog-backdrop" role="presentation">
          <section
            className="feature-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-question-heading"
          >
            <h2 id="delete-question-heading">Retire this question?</h2>
            <p>The booth will stop offering this prompt, but existing messages stay on file.</p>
            <div className="debug-button-row">
              <button
                type="button"
                onClick={() =>
                  void deleteQuestion.mutateAsync(deleteId).then(() => setDeleteId(null))
                }
              >
                Confirm delete
              </button>
              <button type="button" onClick={() => setDeleteId(null)}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}
    </GlassPanel>
  );
}
