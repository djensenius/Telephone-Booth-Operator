import { useState } from "react";
import type { FormEvent, JSX } from "react";
import type { Instruction, InstructionStatus } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  AUDIO_UPLOAD_ACCEPT,
  audioUploadContentType,
  sha256Hex,
  uploadBlobToSas,
  uploads,
  useActivateInstruction,
  useCreateInstruction,
  useDeactivateInstruction,
  useDeleteInstruction,
  useInstructionsList,
  useUpdateInstruction,
} from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const INSTRUCTION_FILTERS: readonly (InstructionStatus | "all")[] = ["all", "active", "inactive"];

function duration(ms: number | null): string {
  if (ms === null) return "Unknown";
  return `${Math.round(ms / 1000)}s`;
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}

export function NewInstructionDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element | null {
  const createInstruction = useCreateInstruction();
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (file === null) return;
    setUploadError(null);
    try {
      setStatus("Reserving a clean line for the instruction audio…");
      const sha256 = await sha256Hex(file);
      const contentType = audioUploadContentType(file);
      const slot = await uploads.sas({
        kind: "instruction-audio",
        sha256,
        sizeBytes: file.size,
        contentType,
      });
      if (slot.audioFileId === undefined)
        throw new Error("Upload slot did not include an audio file id.");
      setStatus("Sending the instruction audio up the wire…");
      await uploadBlobToSas(slot.uploadUrl, file, contentType);
      setStatus("Filing the instruction card…");
      await createInstruction.mutateAsync({
        description: description.trim() || undefined,
        audioFileId: slot.audioFileId,
      });
      setDescription("");
      setFile(null);
      setStatus("");
      onClose();
    } catch {
      setStatus("");
      setUploadError("The instructions could not be filed.");
    }
  }

  return (
    <div className="feature-dialog-backdrop" role="presentation">
      <section
        className="feature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-instruction-heading"
      >
        <h2 id="new-instruction-heading">New instructions</h2>
        <form className="feature-form" onSubmit={(event) => void submit(event)}>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              maxLength={280}
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
          {createInstruction.error || uploadError !== null ? (
            <FeatureError message={uploadError ?? "The instructions could not be filed."} />
          ) : null}
          <p aria-live="polite">{status}</p>
          <div className="debug-button-row">
            <button type="submit" disabled={createInstruction.isPending || file === null}>
              Upload instructions
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

export function EditInstructionDialog({
  instruction,
  onClose,
}: {
  readonly instruction: Instruction | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  const updateInstruction = useUpdateInstruction();
  const [description, setDescription] = useState(instruction?.description ?? "");

  if (instruction === null) return null;
  const instructionId = instruction.id;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    updateInstruction.mutate(
      {
        id: instructionId,
        input: { description: description.trim() || null },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <div className="feature-dialog-backdrop" role="presentation">
      <section
        className="feature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-instruction-heading"
      >
        <h2 id="edit-instruction-heading">Edit instruction description</h2>
        <form className="feature-form" onSubmit={submit}>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              maxLength={280}
            />
          </label>
          {updateInstruction.error ? (
            <FeatureError message="The instruction description could not be updated." />
          ) : null}
          <div className="debug-button-row">
            <button type="submit" disabled={updateInstruction.isPending}>
              Save description
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

export function InstructionsScreen(): JSX.Element {
  const [filter, setFilter] = useState<InstructionStatus | "all">("all");
  const instructions = useInstructionsList(filter);
  const deleteInstruction = useDeleteInstruction();
  const activateInstruction = useActivateInstruction();
  const deactivateInstruction = useDeactivateInstruction();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState<Instruction | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const rows = instructions.data?.items ?? [];

  return (
    <GlassPanel title="Instruction library" className="feature-screen questions-screen">
      <p className="screen-kicker">Digit 8</p>
      <h1>Instructions</h1>
      <p>
        Upload instruction clips for the booth to choose from at random. Every active clip stays in
        the calling pool.
      </p>
      <div className="feature-toolbar" role="toolbar" aria-label="Instruction filters">
        {INSTRUCTION_FILTERS.map((option) => (
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
      <div className="feature-actions">
        <button
          className="feature-primary-button"
          type="button"
          onClick={() => setDialogOpen(true)}
        >
          New instructions
        </button>
      </div>
      {instructions.isLoading ? <FeatureSkeleton /> : null}
      {instructions.error ? (
        <FeatureError message="Could not load the instruction library." />
      ) : null}
      {!instructions.isLoading && rows.length === 0 ? (
        <FeatureEmpty title="No instructions on the line">
          Upload the first booth instruction clip.
        </FeatureEmpty>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="feature-table-wrap">
          <table className="feature-table">
            <caption>Instruction library</caption>
            <thead>
              <tr>
                <th>Description</th>
                <th>Status</th>
                <th>Audio duration</th>
                <th>Created</th>
                <th>Preview</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((instruction) => (
                <tr key={instruction.id}>
                  <td>{instruction.description ?? "—"}</td>
                  <td>
                    <span className={`question-status question-status-${instruction.status}`}>
                      {instruction.status}
                    </span>
                  </td>
                  <td>{duration(instruction.audio.durationMs)}</td>
                  <td>{date(instruction.createdAt)}</td>
                  <td>
                    <audio controls src={instruction.audio.url}>
                      Instruction audio
                    </audio>
                    <a href={instruction.audio.url} download>
                      Download
                    </a>
                  </td>
                  <td>
                    <div className="debug-button-row">
                      {instruction.status === "active" ? (
                        <button
                          type="button"
                          disabled={deactivateInstruction.isPending}
                          onClick={() => void deactivateInstruction.mutateAsync(instruction.id)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={activateInstruction.isPending}
                          onClick={() => void activateInstruction.mutateAsync(instruction.id)}
                        >
                          Activate
                        </button>
                      )}
                      <button type="button" onClick={() => setEditInstruction(instruction)}>
                        Edit description
                      </button>
                      <button type="button" onClick={() => setDeleteId(instruction.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewInstructionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <EditInstructionDialog
        key={editInstruction?.id}
        instruction={editInstruction}
        onClose={() => setEditInstruction(null)}
      />
      {deleteId === null ? null : (
        <section
          className="feature-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-instruction-heading"
        >
          <h2 id="delete-instruction-heading">Delete this instruction?</h2>
          <p>The booth will stop choosing this clip from the active instruction pool.</p>
          <div className="debug-button-row">
            <button
              type="button"
              onClick={() =>
                void deleteInstruction.mutateAsync(deleteId).then(() => setDeleteId(null))
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
