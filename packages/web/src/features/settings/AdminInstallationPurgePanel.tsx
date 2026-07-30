import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { Installation, InstallationPurgeResult } from "@telephone-booth-operator/shared";
import {
  ApiError,
  installations as installationsApi,
  useInstallationsList,
  usePurgeInstallation,
} from "../../lib/api-client.js";

type Status =
  | { kind: "idle" }
  | { kind: "archiving" }
  | { kind: "archived"; message: string }
  | { kind: "purging" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: InstallationPurgeResult };

function purgeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return "The confirmation name did not match.";
    if (error.status === 409) return "That installation is still active and cannot be purged.";
    return error.message || "Purge failed.";
  }
  return error instanceof Error ? error.message : "Purge failed.";
}

// Names are not unique, and two runs of the same festival can share one. The
// purge is irreversible, so the option has to say which row it is: the era's
// start date and the head of its id disambiguate identically-named runs.
function optionLabel(installation: Installation): string {
  const started = new Date(installation.startedAt);
  const stamp = Number.isNaN(started.getTime())
    ? installation.startedAt
    : started.toLocaleDateString();
  return `${installation.name} — started ${stamp} (${installation.id.slice(0, 8)})`;
}

// Admin-only irreversible hard purge of a single ENDED installation and its
// audio blobs. Guarded by a required archive download and an exact-name
// confirmation so it can never be triggered by accident.
export function AdminInstallationPurgePanel(): JSX.Element {
  const listQuery = useInstallationsList();
  const purge = usePurgeInstallation();
  const [selectedId, setSelectedId] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Only ended installations can be purged — the active era is never offered.
  const endable = useMemo(
    () => (listQuery.data?.items ?? []).filter((installation) => !installation.isActive),
    [listQuery.data],
  );
  const selected = endable.find((installation) => installation.id === selectedId) ?? null;
  const archived = selectedId.length > 0 && archivedIds.has(selectedId);
  const nameMatches = selected !== null && confirmName === selected.name;
  const canPurge = selected !== null && archived && nameMatches && status.kind !== "purging";

  const handleSelect = (id: string): void => {
    setSelectedId(id);
    setConfirmName("");
    setStatus({ kind: "idle" });
  };

  const handleArchive = async (): Promise<void> => {
    if (selected === null) return;
    setStatus({ kind: "archiving" });
    try {
      const { blob, filename } = await installationsApi.exportArchive(selected.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setArchivedIds((prev) => new Set(prev).add(selected.id));
      setStatus({ kind: "archived", message: `Downloaded ${filename}` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Archive download failed.",
      });
    }
  };

  const handlePurge = (): void => {
    if (selected === null || !canPurge) return;
    setStatus({ kind: "purging" });
    purge.mutate(
      { id: selected.id, confirmName },
      {
        onSuccess: (result) => {
          setStatus({ kind: "done", result });
          setSelectedId("");
          setConfirmName("");
          setArchivedIds(new Set());
        },
        onError: (error) => setStatus({ kind: "error", message: purgeErrorMessage(error) }),
      },
    );
  };

  return (
    <section className="feature-card">
      <h2>Hard-purge an installation</h2>
      <p>
        Irreversibly deletes one ended installation and its audio blobs. This cannot be undone —
        download an archive first. Admin only.
      </p>
      <div className="settings-list">
        <label>
          Installation
          <select value={selectedId} onChange={(event) => handleSelect(event.currentTarget.value)}>
            <option value="">Choose an ended installation…</option>
            {endable.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {optionLabel(installation)}
              </option>
            ))}
          </select>
        </label>
        {selected === null ? null : (
          <>
            <button
              type="button"
              onClick={() => void handleArchive()}
              disabled={status.kind === "archiving"}
            >
              {status.kind === "archiving"
                ? "Preparing archive…"
                : archived
                  ? "Download archive again"
                  : "Download archive (required)"}
            </button>
            <label>
              Type <strong>{selected.name}</strong> to confirm
              <input
                type="text"
                value={confirmName}
                autoComplete="off"
                onChange={(event) => setConfirmName(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="installations-danger"
              onClick={handlePurge}
              disabled={!canPurge}
            >
              {status.kind === "purging" ? "Purging…" : "Permanently delete installation"}
            </button>
            {!archived ? (
              <p className="installations-hint">Download the archive to enable purging.</p>
            ) : !nameMatches ? (
              <p className="installations-hint">
                Type the installation name exactly to enable purging.
              </p>
            ) : null}
          </>
        )}
      </div>
      {status.kind === "archived" ? (
        <p className="settings-status" role="status">
          {status.message} — you can now purge.
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="settings-status settings-status--error" role="status">
          {status.message}
        </p>
      ) : null}
      {status.kind === "done" ? (
        <div className="settings-status" role="status">
          <p>
            Purged installation {status.result.installationId}. Deleted{" "}
            {Object.values(status.result.rows).reduce((a, b) => a + b, 0)} rows and{" "}
            {status.result.blobsDeleted} audio blobs ({status.result.blobsRetained} retained).
          </p>
          {status.result.blobFailures.length > 0 ? (
            <p>
              {status.result.blobFailures.length} blob(s) could not be deleted:{" "}
              {status.result.blobFailures.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
