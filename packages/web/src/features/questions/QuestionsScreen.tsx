import { useState } from "react";
import type { FormEvent } from "react";
import { GlassPanel } from "../../components/booth/index.js";
import {
  sha256Hex,
  uploadBlobToSas,
  uploads,
  useCreateQuestion,
  useDeleteQuestion,
  useQuestionsList,
} from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

function duration(ms: number | null): string {
  if (ms === null) return "Unknown";
  return `${Math.round(ms / 1000)}s`;
}

function date(value: string): string {
  return new Date(value).toLocaleString();
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

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (file === null) return;
    setStatus("Reserving a clean line for the audio…");
    const sha256 = await sha256Hex(file);
    const slot = await uploads.sas({
      kind: "question-audio",
      sha256,
      sizeBytes: file.size,
      contentType: "audio/flac",
    });
    if (slot.audioFileId === undefined)
      throw new Error("Upload slot did not include an audio file id.");
    setStatus("Sending the question audio up the wire…");
    await uploadBlobToSas(slot.uploadUrl, file);
    setStatus("Filing the prompt card…");
    await createQuestion.mutateAsync({ prompt, audioFileId: slot.audioFileId });
    setPrompt("");
    setFile(null);
    setStatus("");
    onClose();
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
            Audio file (FLAC)
            <input
              type="file"
              accept="audio/flac,.flac"
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              required
            />
          </label>
          {createQuestion.error ? (
            <FeatureError message="The question could not be filed." />
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

export function QuestionsScreen({
  startNew = false,
}: { readonly startNew?: boolean } = {}): JSX.Element {
  const questions = useQuestionsList();
  const deleteQuestion = useDeleteQuestion();
  const [dialogOpen, setDialogOpen] = useState(startNew);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const rows = questions.data?.items ?? [];

  return (
    <GlassPanel title="Question library" className="feature-screen questions-screen">
      <p className="screen-kicker">Digit 3</p>
      <h1>Questions</h1>
      <p>Keep the booth supplied with prompt cards and their matching audio.</p>
      <div className="feature-actions">
        <button
          className="feature-primary-button"
          type="button"
          onClick={() => setDialogOpen(true)}
        >
          New question
        </button>
      </div>
      {questions.isLoading ? <FeatureSkeleton /> : null}
      {questions.error ? <FeatureError message="Could not load the question library." /> : null}
      {!questions.isLoading && rows.length === 0 ? (
        <FeatureEmpty title="No questions on the line">
          Place a call to add the first booth prompt.
        </FeatureEmpty>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="feature-table-wrap">
          <table className="feature-table">
            <caption>Question library</caption>
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Audio duration</th>
                <th>Created</th>
                <th>Preview</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((question) => (
                <tr key={question.id}>
                  <td>{question.prompt}</td>
                  <td>{duration(question.audio.durationMs)}</td>
                  <td>{date(question.createdAt)}</td>
                  <td>
                    <audio controls src={question.audio.url}>
                      Question audio
                    </audio>
                  </td>
                  <td>
                    <button type="button" onClick={() => setDeleteId(question.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewQuestionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      {deleteId === null ? null : (
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
      )}
    </GlassPanel>
  );
}
