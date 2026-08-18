import type { FormEvent, JSX } from "react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Installation, InstallationSummary } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  ApiError,
  useCreateInstallation,
  useEndInstallation,
  useInstallationsList,
  useStatsSummary,
  useUpdateInstallation,
  installations as installationsApi,
} from "../../lib/api-client.js";
import { absoluteTime } from "../../lib/time-format.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

function fmtNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

// Recorded audio totals can run to hours across a whole installation, so this
// includes an hours component that `durationLabel` (built for single clips)
// omits.
function fmtRecordedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return error.message || "That action conflicts with the current state.";
    }
    if (error.status === 503) {
      return "The installations service is temporarily unavailable, so the action didn't complete. Try again in a moment.";
    }
    return error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

// The Start endpoint can still return 409 if another rollover wins the same
// race. Keep the operator-facing message actionable instead of surfacing the
// raw API code.
function startInstallationErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    const details = error.details;
    const rawCode =
      typeof details === "object" && details !== null && "error" in details
        ? (details as { readonly error?: unknown }).error
        : undefined;
    const code = typeof rawCode === "string" ? rawCode : "";
    if (code === "installation_already_active") {
      return "Another installation rollover completed first. Refresh the list, confirm the active installation, and try again if you still need a new era.";
    }
    return error.message || "That action conflicts with the current state.";
  }
  return errorMessage(error, "Could not start the installation.");
}

interface SummaryTileProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

function SummaryTile({ label, value, hint }: SummaryTileProps): JSX.Element {
  return (
    <div className="stats-tile">
      <span className="stats-tile__label">{label}</span>
      <strong className="stats-tile__value">{value}</strong>
      {hint === undefined ? null : <span className="stats-tile__hint">{hint}</span>}
    </div>
  );
}

function FrozenSummary({ summary }: { readonly summary: InstallationSummary }): JSX.Element {
  return (
    <div className="stats-tiles installations-summary">
      <SummaryTile label="Calls" value={fmtNumber(summary.calls)} />
      <SummaryTile label="Playable messages" value={fmtNumber(summary.messages)} />
      <SummaryTile label="All recordings" value={fmtNumber(summary.allRecordings)} />
      <SummaryTile label="Approved" value={fmtNumber(summary.messagesApproved)} />
      <SummaryTile label="Rejected" value={fmtNumber(summary.messagesRejected)} />
      <SummaryTile label="Questions" value={fmtNumber(summary.questions)} />
      <SummaryTile label="Events" value={fmtNumber(summary.events)} />
      <SummaryTile label="Recorded" value={fmtRecordedMs(summary.recordedMs)} />
    </div>
  );
}

function ActiveSummary(): JSX.Element {
  const summaryQuery = useStatsSummary();
  if (summaryQuery.isPending) return <FeatureSkeleton label="Reading live counters…" />;
  if (summaryQuery.isError || summaryQuery.data === undefined) {
    return (
      <p className="settings-status settings-status--error" role="status">
        Live counters are unavailable right now.
      </p>
    );
  }
  const summary = summaryQuery.data;
  return (
    <div className="stats-tiles installations-summary">
      <SummaryTile label="Calls today" value={fmtNumber(summary.calls.today)} />
      <SummaryTile label="Calls in progress" value={fmtNumber(summary.calls.inProgress)} />
      <SummaryTile label="Messages today" value={fmtNumber(summary.messages.receivedToday)} />
      <SummaryTile label="Pending" value={fmtNumber(summary.messages.pending)} />
      <SummaryTile
        label="Awaiting moderation"
        value={fmtNumber(summary.messages.awaitingModeration)}
      />
    </div>
  );
}

type ArchiveState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

function DownloadArchiveButton({
  installation,
}: {
  readonly installation: Installation;
}): JSX.Element {
  const [state, setState] = useState<ArchiveState>({ kind: "idle" });

  const handleDownload = async (): Promise<void> => {
    setState({ kind: "working" });
    try {
      const { blob, filename } = await installationsApi.exportArchive(installation.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Safari has not necessarily started fetching the blob by the time the
      // click handler returns, and revoking under it kills the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState({ kind: "done", message: `Downloaded ${filename}` });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error, "Archive download failed.") });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={state.kind === "working"}
      >
        {state.kind === "working" ? "Preparing archive…" : "Download archive"}
      </button>
      {state.kind === "error" || state.kind === "done" ? (
        <p
          className={
            state.kind === "error" ? "settings-status settings-status--error" : "settings-status"
          }
          role="status"
        >
          {state.message}
        </p>
      ) : null}
    </>
  );
}

function EndInstallationForm({
  installation,
}: {
  readonly installation: Installation;
}): JSX.Element {
  const endInstallation = useEndInstallation();
  const [confirming, setConfirming] = useState(false);
  const [notes, setNotes] = useState(installation.notes ?? "");
  const [location, setLocation] = useState(installation.location ?? "");

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    endInstallation.mutate(
      {
        id: installation.id,
        input: {
          notes: notes.trim().length === 0 ? null : notes.trim(),
          location: location.trim().length === 0 ? null : location.trim(),
        },
      },
      { onSuccess: () => setConfirming(false) },
    );
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className="installations-danger"
        onClick={() => {
          // Seed from the freshest installation data every time the form
          // opens. The edit form can rename/renote the same active card
          // without remounting this component, so the state set at mount
          // could otherwise be stale — ending would silently overwrite the
          // newer notes/location. Reseeding here also leaves an already-open
          // form alone, so mid-typing edits are preserved.
          setNotes(installation.notes ?? "");
          setLocation(installation.location ?? "");
          setConfirming(true);
        }}
      >
        End installation
      </button>
    );
  }

  return (
    <form className="settings-list installations-end-form" onSubmit={handleSubmit}>
      <p>
        Ending <strong>{installation.name}</strong> freezes its counters, closes open calls, empties
        the moderation queue, and archives its questions. Nothing is deleted — the era stays
        browsable.
      </p>
      <label>
        Notes (optional)
        <textarea
          value={notes}
          rows={2}
          maxLength={2000}
          onChange={(event) => setNotes(event.currentTarget.value)}
        />
      </label>
      <label>
        Location (optional)
        <input
          type="text"
          value={location}
          maxLength={200}
          onChange={(event) => setLocation(event.currentTarget.value)}
        />
      </label>
      {endInstallation.isError ? (
        <p className="settings-status settings-status--error" role="status">
          {errorMessage(endInstallation.error, "Could not end the installation.")}
        </p>
      ) : null}
      <div className="debug-button-row">
        <button type="submit" className="installations-danger" disabled={endInstallation.isPending}>
          {endInstallation.isPending ? "Ending…" : "Confirm end"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={endInstallation.isPending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditActiveInstallationForm({
  installation,
}: {
  readonly installation: Installation;
}): JSX.Element {
  const updateInstallation = useUpdateInstallation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(installation.name);
  const [notes, setNotes] = useState(installation.notes ?? "");
  const [location, setLocation] = useState(installation.location ?? "");
  const [defaultTranscriptionLanguage, setDefaultTranscriptionLanguage] = useState(
    installation.defaultTranscriptionLanguage ?? "",
  );

  const reset = (): void => {
    setName(installation.name);
    setNotes(installation.notes ?? "");
    setLocation(installation.location ?? "");
    setDefaultTranscriptionLanguage(installation.defaultTranscriptionLanguage ?? "");
  };

  const cancel = (): void => {
    reset();
    updateInstallation.reset();
    setEditing(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || updateInstallation.isPending) return;
    updateInstallation.mutate(
      {
        id: installation.id,
        input: {
          name: trimmed,
          notes: notes.trim().length === 0 ? null : notes.trim(),
          location: location.trim().length === 0 ? null : location.trim(),
          defaultTranscriptionLanguage:
            defaultTranscriptionLanguage.trim().length === 0
              ? null
              : defaultTranscriptionLanguage.trim(),
        },
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          reset();
          updateInstallation.reset();
          setEditing(true);
        }}
      >
        Edit details
      </button>
    );
  }

  return (
    <form className="settings-list installations-edit-form" onSubmit={handleSubmit}>
      <p>
        A powered-on booth opens an unnamed era automatically. Rename the active installation here
        to give this run a memorable name — this is the only way to relabel it once the booth has
        recorded into it.
      </p>
      <label>
        Name
        <input
          type="text"
          value={name}
          required
          maxLength={120}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        Notes (optional)
        <textarea
          value={notes}
          rows={2}
          maxLength={2000}
          onChange={(event) => setNotes(event.currentTarget.value)}
        />
      </label>
      <label>
        Location (optional)
        <input
          type="text"
          value={location}
          maxLength={200}
          onChange={(event) => setLocation(event.currentTarget.value)}
        />
      </label>
      <label>
        Default transcription language (optional BCP-47 tag)
        <input
          type="text"
          value={defaultTranscriptionLanguage}
          maxLength={64}
          placeholder="en-CA"
          onChange={(event) => setDefaultTranscriptionLanguage(event.currentTarget.value)}
        />
      </label>
      {updateInstallation.isError ? (
        <p className="settings-status settings-status--error" role="status">
          {errorMessage(updateInstallation.error, "Could not update the installation.")}
        </p>
      ) : null}
      <div className="debug-button-row">
        <button type="submit" disabled={name.trim().length === 0 || updateInstallation.isPending}>
          {updateInstallation.isPending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={cancel} disabled={updateInstallation.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type StartInstallationFormProps = {
  readonly startStatus: string | null;
  readonly onStartStatusChange: (status: string | null) => void;
};

function StartInstallationForm({
  startStatus,
  onStartStatusChange,
}: StartInstallationFormProps): JSX.Element {
  const createInstallation = useCreateInstallation();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [location, setLocation] = useState("");
  const [defaultTranscriptionLanguage, setDefaultTranscriptionLanguage] = useState("");
  const [copyQuestions, setCopyQuestions] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim().length === 0 || createInstallation.isPending) return;
    onStartStatusChange(null);
    createInstallation.mutate(
      {
        name: name.trim(),
        notes: notes.trim().length === 0 ? null : notes.trim(),
        location: location.trim().length === 0 ? null : location.trim(),
        defaultTranscriptionLanguage:
          defaultTranscriptionLanguage.trim().length === 0
            ? null
            : defaultTranscriptionLanguage.trim(),
        copyQuestions,
      },
      {
        onSuccess: (installation) => {
          setName("");
          setNotes("");
          setLocation("");
          setDefaultTranscriptionLanguage("");
          setCopyQuestions(false);
          onStartStatusChange(
            `Started ${installation.name}. Any previously active installation was ended automatically.`,
          );
        },
      },
    );
  };
  return (
    <section className="feature-card">
      <h2>Start a new installation</h2>
      <p>
        Opening a new era automatically ends the current installation first, then starts this one.
      </p>
      <form className="settings-list" onSubmit={handleSubmit}>
        <label>
          Name
          <input
            type="text"
            value={name}
            required
            maxLength={120}
            placeholder="Summer 2027 residency"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          Notes (optional)
          <textarea
            value={notes}
            rows={2}
            maxLength={2000}
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
        </label>
        <label>
          Location (optional)
          <input
            type="text"
            value={location}
            maxLength={200}
            onChange={(event) => setLocation(event.currentTarget.value)}
          />
        </label>
        <label>
          Default transcription language (optional BCP-47 tag)
          <input
            type="text"
            value={defaultTranscriptionLanguage}
            maxLength={64}
            placeholder="en-CA"
            onChange={(event) => setDefaultTranscriptionLanguage(event.currentTarget.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={copyQuestions}
            onChange={(event) => setCopyQuestions(event.currentTarget.checked)}
          />{" "}
          Copy the current questions into the new installation
        </label>
        <p className="installations-hint">
          Leave this unchecked to start the new era with no questions. When checked, the questions
          that were live when the last era ended come across as active and its drafts come across as
          drafts, all without re-uploading any audio.
        </p>
        {createInstallation.isError ? (
          <p className="settings-status settings-status--error" role="status">
            {startInstallationErrorMessage(createInstallation.error)}
          </p>
        ) : null}
        {startStatus ? (
          <p className="settings-status" role="status">
            {startStatus}
          </p>
        ) : null}
        <div className="debug-button-row">
          <button type="submit" disabled={name.trim().length === 0 || createInstallation.isPending}>
            {createInstallation.isPending ? "Starting…" : "Start installation"}
          </button>
        </div>
      </form>
    </section>
  );
}

function InstallationCard({ installation }: { readonly installation: Installation }): JSX.Element {
  const navigate = useNavigate();
  return (
    <section className="feature-card installations-card">
      <div className="installations-card__head">
        <div>
          <h2>{installation.name}</h2>
          <p className="installations-card__meta">
            Started {absoluteTime(installation.startedAt) ?? installation.startedAt}
            {installation.endedAt === null
              ? null
              : ` · Ended ${absoluteTime(installation.endedAt) ?? installation.endedAt}`}
            {installation.location === null ? null : ` · ${installation.location}`}
            {installation.defaultTranscriptionLanguage === null ||
            installation.defaultTranscriptionLanguage === undefined
              ? null
              : ` · transcription ${installation.defaultTranscriptionLanguage}`}
          </p>
        </div>
        {installation.isActive ? (
          <span className="admin-badge" title="The currently active installation">
            Active
          </span>
        ) : null}
      </div>
      {installation.notes === null ? null : (
        <p className="installations-card__notes">{installation.notes}</p>
      )}
      {installation.isActive ? (
        <ActiveSummary />
      ) : installation.summary === null ? (
        <p className="settings-status" role="status">
          No frozen summary was recorded for this installation.
        </p>
      ) : (
        <FrozenSummary summary={installation.summary} />
      )}
      <div className="debug-button-row">
        <DownloadArchiveButton installation={installation} />
        {installation.isActive ? (
          <>
            <EditActiveInstallationForm installation={installation} />
            <EndInstallationForm installation={installation} />
          </>
        ) : (
          // Every observability screen takes the scope in its URL, so the era
          // card links straight into each rather than making the operator
          // reconstruct the scope by hand from the picker.
          <>
            <button
              type="button"
              onClick={() =>
                void navigate({ to: "/stats", search: { installationId: installation.id } })
              }
            >
              View stats
            </button>
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: "/messages",
                  search: { status: "all", installationId: installation.id },
                })
              }
            >
              View messages
            </button>
            <button
              type="button"
              onClick={() =>
                void navigate({ to: "/sessions", search: { installationId: installation.id } })
              }
            >
              View calls
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function InstallationsScreen(): JSX.Element {
  const listQuery = useInstallationsList();
  const [startStatus, setStartStatus] = useState<string | null>(null);
  const ordered = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    return [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [listQuery.data]);
  const hasActive = ordered.some((installation) => installation.isActive);

  return (
    <GlassPanel title="Installations" className="feature-screen installations-screen">
      <p className="screen-kicker">Operator console · Admin</p>
      <h1>Installations</h1>
      <p>
        An installation is one run of the booth. At most one era is active at a time — none between
        ending one and the booth&rsquo;s next call, which starts the next. Ending an era freezes its
        counters and archives its questions without deleting anything.
      </p>
      {hasActive ? null : (
        <StartInstallationForm startStatus={startStatus} onStartStatusChange={setStartStatus} />
      )}
      {listQuery.isError ? (
        <FeatureError
          message={
            listQuery.error instanceof Error
              ? listQuery.error.message
              : "Unable to load installations."
          }
        />
      ) : null}
      {listQuery.isPending ? <FeatureSkeleton label="Gathering the eras…" /> : null}
      {!listQuery.isPending && ordered.length === 0 ? (
        <FeatureEmpty title="No installations yet">
          Start the first installation to begin tagging booth activity.
        </FeatureEmpty>
      ) : null}
      <div className="installations-list">
        {ordered.map((installation) => (
          <InstallationCard key={installation.id} installation={installation} />
        ))}
      </div>
      {hasActive ? (
        <StartInstallationForm startStatus={startStatus} onStartStatusChange={setStartStatus} />
      ) : null}
    </GlassPanel>
  );
}
