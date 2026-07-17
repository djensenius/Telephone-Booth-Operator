import { useRef, useState } from "react";
import { adminData, type AdminImportSummary } from "../../lib/api-client.js";

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

// Admin-only full data + audio backup. Export downloads a tar archive;
// import restores one into this instance. Rendered only when the current
// operator is an admin.
export function AdminBackupPanel(): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInput = useRef<HTMLInputElement | null>(null);

  const handleExport = async (): Promise<void> => {
    setStatus({ kind: "working", message: "Preparing export…" });
    try {
      const { blob, filename } = await adminData.export();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus({ kind: "done", message: `Downloaded ${filename}` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Export failed.",
      });
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    setStatus({ kind: "working", message: `Restoring ${file.name}…` });
    try {
      const summary: AdminImportSummary = await adminData.import(file);
      const rowTotal = Object.values(summary.rows).reduce((a, b) => a + b, 0);
      setStatus({
        kind: "done",
        message: `Restored ${rowTotal} rows and uploaded ${summary.blobsUploaded} audio files (${summary.blobsSkipped} skipped).`,
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Import failed.",
      });
    }
  };

  const working = status.kind === "working";

  return (
    <section className="feature-card">
      <h2>Data backup &amp; restore</h2>
      <p>
        Export a complete backup (all data plus audio) or restore one into this instance. Admin
        only.
      </p>
      <div className="debug-button-row">
        <button type="button" onClick={() => void handleExport()} disabled={working}>
          Export all data
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={working}>
          Import from archive…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".tar,application/x-tar"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleImport(file);
          }}
        />
      </div>
      {status.kind === "idle" ? null : (
        <p
          className={
            status.kind === "error" ? "settings-status settings-status--error" : "settings-status"
          }
          role="status"
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
