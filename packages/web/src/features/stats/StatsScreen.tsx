import type { JSX } from "react";
// Operator-facing usage stats screen. Reads aggregated counters from
// `/v1/stats/overview`; the API is responsible for time-window bucketing
// (all in UTC) and we reformat for the local operator here.

import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { STATS_WINDOW_VALUES } from "@telephone-booth-operator/shared";
import type {
  InstallationScope,
  MetricFilter,
  StatsOverview,
  StatsWindow,
} from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  InstallationScopePicker,
  parseInstallationScopeParam,
} from "../installations/InstallationScopePicker.js";
import {
  useCreateMetricFilter,
  useDeleteMetricFilter,
  useMetricFilters,
  useStatsOverview,
  type StatsRangeSelection,
} from "../../lib/api-client.js";
import { FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const WINDOW_LABEL: Record<StatsWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

const OUTCOME_LABEL: Record<string, string> = {
  recording_completed: "Recording completed",
  hung_up_before_dial: "Hung up before dialing",
  hung_up_during_prompt: "Hung up during prompt",
  hung_up_during_recording: "Hung up during recording",
  hung_up_during_upload: "Hung up during upload",
  recording_failed: "Recording failed",
  upload_failed: "Upload failed",
  operator_error: "Operator error",
  aborted: "Aborted",
};

const OUTCOME_ORDER: readonly string[] = [
  "recording_completed",
  "hung_up_before_dial",
  "hung_up_during_prompt",
  "hung_up_during_recording",
  "hung_up_during_upload",
  "recording_failed",
  "upload_failed",
  "operator_error",
  "aborted",
];

const STATUS_LABEL: Record<string, string> = {
  uploading: "Uploading",
  received: "Received",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

const STATUS_ORDER: readonly string[] = [
  "uploading",
  "received",
  "pending",
  "approved",
  "rejected",
];

const DAY_OF_WEEK_LABEL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function fmtNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function fmtPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

function fmtDurationMs(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function fmtHour(hour: number | null): string {
  if (hour === null) return "—";
  const am = hour < 12;
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${am ? "AM" : "PM"} UTC`;
}

function fmtTimeAgo(iso: string | null): string {
  if (iso === null) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Unknown";
  const delta = Date.now() - then;
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function fmtDateShort(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

interface OrderedEntry {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

function orderRecord(
  record: Record<string, number>,
  canonical: readonly string[],
  labels: Record<string, string>,
): OrderedEntry[] {
  const known: OrderedEntry[] = [];
  const seen = new Set<string>();
  for (const key of canonical) {
    if (key in record) {
      known.push({ key, label: labels[key] ?? key, value: record[key] ?? 0 });
      seen.add(key);
    }
  }
  const unknown: OrderedEntry[] = Object.entries(record)
    .filter(([key]) => !seen.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, label: labels[key] ?? key, value }));
  return [...known, ...unknown];
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

interface BarRowProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly trailing?: string;
}

function BarRow({ label, value, max, trailing }: BarRowProps): JSX.Element {
  const ratio = max > 0 ? value / max : 0;
  const pct = Math.max(2, Math.round(ratio * 100));
  return (
    <div className="stats-bar">
      <span className="stats-bar__label">{label}</span>
      <div className="stats-bar__track" aria-hidden="true">
        <div className="stats-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="stats-bar__value">{trailing ?? fmtNumber(value)}</span>
    </div>
  );
}

interface OverviewProps {
  readonly overview: StatsOverview;
}

function InteractionHeadline({ overview }: OverviewProps): JSX.Element {
  const { interactions, actions } = overview;
  return (
    <GlassPanel title="Pickup overview" className="stats-panel stats-panel--wide">
      <header className="stats-panel__header">
        <h2>What visitors did</h2>
        <p>
          Pickups are unique handset lifts. Dial and playback actions may repeat within one pickup.
        </p>
      </header>
      <div className="stats-tiles">
        <SummaryTile label="Pickups" value={fmtNumber(interactions.total)} hint="handset lifts" />
        <SummaryTile
          label="No selection"
          value={fmtNumber(interactions.noSelection)}
          hint="hung up before dialling"
        />
        <SummaryTile
          label="Wrong numbers"
          value={fmtNumber(actions.wrongNumberAttempts)}
          hint="digits 3–9"
        />
        <SummaryTile
          label="Messages left"
          value={fmtNumber(interactions.messagesLeft)}
          hint="recorded and uploaded"
        />
        <SummaryTile
          label="Messages listened to"
          value={fmtNumber(actions.messagePlaybackStarts)}
          hint="playback started"
        />
        <SummaryTile
          label="Instructions heard"
          value={fmtNumber(actions.instructionPlaybackStarts)}
          hint="playback started"
        />
      </div>
    </GlassPanel>
  );
}

function InteractionsSection({ overview }: OverviewProps): JSX.Element {
  const { interactions } = overview;
  const completionRate =
    interactions.total > 0 ? interactions.messagesLeft / interactions.total : null;
  const outcomes = orderRecord(interactions.outcomes, OUTCOME_ORDER, OUTCOME_LABEL);
  const maxOutcome = outcomes.reduce((max, row) => Math.max(max, row.value), 0);
  const maxPerDay = interactions.perDay.reduce((max, day) => Math.max(max, day.total), 0);
  return (
    <GlassPanel title="Pickups" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Pickups</h2>
        <p>
          {fmtNumber(interactions.total)} pickups · {fmtNumber(interactions.messagesLeft)} messages
          left · {fmtPercent(completionRate)} conversion
        </p>
      </header>
      <div className="stats-tiles">
        <SummaryTile label="In progress now" value={fmtNumber(interactions.inProgressNow)} />
        <SummaryTile label="No selection" value={fmtNumber(interactions.noSelection)} />
        <SummaryTile
          label="Average duration"
          value={fmtDurationMs(interactions.averageDurationMs)}
          hint="ended pickups"
        />
        <SummaryTile
          label="Longest duration"
          value={fmtDurationMs(interactions.longestDurationMs)}
        />
      </div>
      <h3>Pickup outcomes</h3>
      {outcomes.length === 0 ? (
        <p className="stats-empty">No ended pickups yet.</p>
      ) : (
        <div className="stats-bars">
          {outcomes.map((row) => (
            <BarRow key={row.key} label={row.label} value={row.value} max={maxOutcome} />
          ))}
        </div>
      )}
      <h3>Pickups per day (UTC)</h3>
      {interactions.perDay.length === 0 ? (
        <p className="stats-empty">No data in this window.</p>
      ) : (
        <div className="stats-bars stats-bars--days">
          {interactions.perDay.map((day) => (
            <BarRow
              key={day.date}
              label={fmtDateShort(day.date)}
              value={day.total}
              max={maxPerDay}
              trailing={`${day.total} · ${day.messagesLeft} left · ${day.noSelection} no selection`}
            />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

function MessagesSection({ overview }: OverviewProps): JSX.Element {
  const { actions, messages } = overview;
  const statuses = orderRecord(messages.byStatus, STATUS_ORDER, STATUS_LABEL);
  const maxStatus = statuses.reduce((max, row) => Math.max(max, row.value), 0);
  return (
    <GlassPanel title="Messages" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Messages</h2>
        <p>
          {fmtNumber(messages.approved ?? messages.total)} approved/playable ·{" "}
          {fmtNumber(messages.allRecordings ?? messages.total)} recordings · avg{" "}
          {fmtDurationMs(messages.averageDurationMs)} · {fmtNumber(actions.messagePlaybackStarts)}{" "}
          booth playbacks
        </p>
      </header>
      <h3>By status</h3>
      {statuses.length === 0 ? (
        <p className="stats-empty">No messages in this window.</p>
      ) : (
        <div className="stats-bars">
          {statuses.map((row) => (
            <BarRow key={row.key} label={row.label} value={row.value} max={maxStatus} />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

function HourlySection({ overview }: OverviewProps): JSX.Element {
  const { hourly, busiest } = overview;
  const maxInteractions = hourly.reduce((max, b) => Math.max(max, b.interactions), 0);
  return (
    <GlassPanel title="Hourly activity" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Hour of day</h2>
        <p>
          Busiest hour: {fmtHour(busiest.hour)}
          {busiest.dayOfWeek === null ? null : ` · ${DAY_OF_WEEK_LABEL[busiest.dayOfWeek]}`}
        </p>
      </header>
      <div className="stats-heatmap" role="img" aria-label="Pickups per UTC hour">
        {hourly.map((bucket) => {
          const intensity = maxInteractions > 0 ? bucket.interactions / maxInteractions : 0;
          return (
            <div
              key={bucket.hour}
              className="stats-heatmap__cell"
              title={`${bucket.hour}:00 UTC — ${bucket.interactions} pickups, ${bucket.messages} messages`}
              style={{ opacity: 0.2 + intensity * 0.8 }}
            >
              <span className="stats-heatmap__hour">{bucket.hour}</span>
              <span className="stats-heatmap__count">{bucket.interactions}</span>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}

function ActionsSection({ overview }: OverviewProps): JSX.Element {
  const { actions, uploads, lastActivityAt } = overview;
  const digits = Array.from({ length: 10 }, (_, i) => ({
    digit: String(i),
    count: actions.digitsDialed[String(i)] ?? 0,
  }));
  const maxDigit = digits.reduce((max, d) => Math.max(max, d.count), 0);
  return (
    <GlassPanel title="Dial & playback activity" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Dial & playback activity</h2>
        <p>Counts actions, so one pickup can appear more than once.</p>
      </header>
      <div className="stats-tiles">
        <SummaryTile
          label="Dialled 1"
          value={fmtNumber(actions.leaveMessageSelections)}
          hint="leave a message"
        />
        <SummaryTile
          label="Dialled 2"
          value={fmtNumber(actions.listenMessageSelections)}
          hint="listen to a message"
        />
        <SummaryTile
          label="Dialled 0"
          value={fmtNumber(actions.instructionSelections)}
          hint="hear instructions"
        />
        <SummaryTile
          label="Wrong number"
          value={fmtNumber(actions.wrongNumberAttempts)}
          hint="digits 3–9"
        />
        <SummaryTile label="Uploads succeeded" value={fmtNumber(uploads.succeeded)} />
        {uploads.failureRate === null ? (
          <SummaryTile label="Uploads failed" value={fmtNumber(uploads.failed)} />
        ) : (
          <SummaryTile
            label="Uploads failed"
            value={fmtNumber(uploads.failed)}
            hint={fmtPercent(uploads.failureRate)}
          />
        )}
        <SummaryTile label="Last activity" value={fmtTimeAgo(lastActivityAt)} />
      </div>
      <h3>Digits dialed</h3>
      <div className="stats-digits">
        {digits.map((d) => {
          const intensity = maxDigit > 0 ? d.count / maxDigit : 0;
          return (
            <div
              key={d.digit}
              className="stats-digits__cell"
              style={{ opacity: 0.25 + intensity * 0.75 }}
            >
              <span className="stats-digits__digit">{d.digit}</span>
              <span className="stats-digits__count">{fmtNumber(d.count)}</span>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}

function TopQuestionsSection({ overview }: OverviewProps): JSX.Element {
  const { topQuestions } = overview;
  if (topQuestions.length === 0) {
    return (
      <GlassPanel title="Top questions" className="stats-panel">
        <header className="stats-panel__header">
          <h2>Top questions</h2>
        </header>
        <p className="stats-empty">No question responses in this window.</p>
      </GlassPanel>
    );
  }
  const max = topQuestions.reduce((m, q) => Math.max(m, q.messageCount), 0);
  return (
    <GlassPanel title="Top questions" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Top questions</h2>
        <p>Sorted by approved/playable messages in this window.</p>
      </header>
      <ol className="stats-top-questions">
        {topQuestions.map((q) => (
          <li key={q.questionId}>
            <div className="stats-top-questions__head">
              <span className="stats-top-questions__prompt">
                {q.prompt}
                {q.retiredAt === null ? null : <em> (retired)</em>}
              </span>
              <strong>{fmtNumber(q.messageCount)}</strong>
            </div>
            <div className="stats-bar__track" aria-hidden="true">
              <div
                className="stats-bar__fill"
                style={{ width: `${Math.max(2, Math.round((q.messageCount / max) * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ol>
    </GlassPanel>
  );
}

function BoothBreakdownSection({ overview }: OverviewProps): JSX.Element | null {
  const { boothBreakdown } = overview;
  if (boothBreakdown.length === 0) return null;
  return (
    <GlassPanel title="By booth" className="stats-panel">
      <header className="stats-panel__header">
        <h2>By booth</h2>
        <p>Only shown when more than one booth has reported activity in the window.</p>
      </header>
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">Booth</th>
            <th scope="col">Pickups</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {boothBreakdown.map((b) => (
            <tr key={b.boothId}>
              <th scope="row">{b.boothId}</th>
              <td>{fmtNumber(b.interactions)}</td>
              <td>{fmtTimeAgo(b.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  );
}

// datetime-local input <-> ISO helpers. The input yields a local
// "YYYY-MM-DDTHH:mm" string; we round-trip through Date for the API's ISO.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function selectionLabel(selection: StatsRangeSelection): string {
  if (selection.kind === "preset") return WINDOW_LABEL[selection.window];
  const start = selection.start ? new Date(selection.start).toLocaleString() : "the beginning";
  const end = selection.end ? new Date(selection.end).toLocaleString() : "now";
  return `${start} → ${end}`;
}

function filterToSelection(filter: MetricFilter): StatsRangeSelection {
  if (filter.window) return { kind: "preset", window: filter.window };
  return { kind: "custom", start: filter.start, end: filter.end };
}

function selectionToCreate(name: string, selection: StatsRangeSelection) {
  if (selection.kind === "preset") {
    return { name, window: selection.window, start: null, end: null };
  }
  return { name, window: null, start: selection.start, end: selection.end };
}

function StatsControls({
  selection,
  onChange,
}: {
  selection: StatsRangeSelection;
  onChange: (next: StatsRangeSelection) => void;
}): JSX.Element {
  const filtersQuery = useMetricFilters();
  const createFilter = useCreateMetricFilter();
  const deleteFilter = useDeleteMetricFilter();
  const [filterName, setFilterName] = useState("");
  const savedFilters = filtersQuery.data?.items ?? [];

  const custom = selection.kind === "custom" ? selection : null;
  const endIsNow = custom !== null && custom.end === null;

  const handleSave = (): void => {
    const name = filterName.trim();
    if (name.length === 0 || createFilter.isPending) return;
    createFilter.mutate(selectionToCreate(name, selection), {
      onSuccess: () => setFilterName(""),
    });
  };

  return (
    <div className="stats-controls">
      <fieldset className="stats-window-picker" aria-label="Time range">
        <legend className="visually-hidden">Time range</legend>
        {STATS_WINDOW_VALUES.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="stats-window"
              value={option}
              checked={selection.kind === "preset" && selection.window === option}
              onChange={() => onChange({ kind: "preset", window: option })}
            />
            <span>{WINDOW_LABEL[option]}</span>
          </label>
        ))}
        <label>
          <input
            type="radio"
            name="stats-window"
            value="custom"
            checked={selection.kind === "custom"}
            onChange={() => onChange({ kind: "custom", start: null, end: null })}
          />
          <span>Custom range</span>
        </label>
      </fieldset>

      {custom === null ? null : (
        <fieldset className="stats-custom-range" aria-label="Custom range">
          <legend className="visually-hidden">Custom range bounds</legend>
          <label>
            <span>Start</span>
            <input
              type="datetime-local"
              value={isoToLocalInput(custom.start)}
              onChange={(event) =>
                onChange({ ...custom, start: localInputToIso(event.target.value) })
              }
            />
          </label>
          <label>
            <span>End</span>
            <input
              type="datetime-local"
              value={isoToLocalInput(custom.end)}
              disabled={endIsNow}
              onChange={(event) =>
                onChange({ ...custom, end: localInputToIso(event.target.value) })
              }
            />
          </label>
          <label className="stats-now-toggle">
            <input
              type="checkbox"
              checked={endIsNow}
              onChange={(event) =>
                onChange({ ...custom, end: event.target.checked ? null : new Date().toISOString() })
              }
            />
            <span>End = now (live)</span>
          </label>
        </fieldset>
      )}

      <div className="stats-saved-filters">
        <label>
          <span>Saved filters</span>
          <select
            value=""
            onChange={(event) => {
              const found = savedFilters.find((f) => f.id === event.target.value);
              if (found) onChange(filterToSelection(found));
            }}
          >
            <option value="">Load a saved filter…</option>
            {savedFilters.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.name}
              </option>
            ))}
          </select>
        </label>
        <div className="stats-save-filter">
          <input
            type="text"
            placeholder="Name this filter"
            value={filterName}
            maxLength={80}
            onChange={(event) => setFilterName(event.target.value)}
          />
          <button type="button" onClick={handleSave} disabled={filterName.trim().length === 0}>
            Save current
          </button>
        </div>
        {savedFilters.length > 0 ? (
          <ul className="stats-saved-filter-list">
            {savedFilters.map((filter) => (
              <li key={filter.id}>
                <button type="button" onClick={() => onChange(filterToSelection(filter))}>
                  {filter.name}
                </button>
                <button
                  type="button"
                  className="stats-filter-delete"
                  aria-label={`Delete ${filter.name}`}
                  onClick={() => deleteFilter.mutate(filter.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function StatsScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const scope = parseInstallationScopeParam(search.installationId);
  const [selection, setSelection] = useState<StatsRangeSelection>({
    kind: "preset",
    window: "7d",
  });
  const query = useStatsOverview(selection, scope);
  const overview = query.data ?? null;

  const handleScopeChange = (next: InstallationScope | undefined): void => {
    void navigate({
      to: "/stats",
      search: next === undefined ? {} : { installationId: next },
      replace: true,
    });
  };

  const generatedAt = useMemo(
    () => (overview ? new Date(overview.generatedAt).toLocaleString() : null),
    [overview],
  );

  return (
    <GlassPanel title="Usage statistics" className="feature-screen stats-screen">
      <header className="stats-screen__header">
        <div>
          <span className="screen-kicker">Operator console</span>
          <h1 id="stats-title">Usage statistics</h1>
          <p className="stats-screen__subtitle">
            {selectionLabel(selection)}
            {generatedAt === null ? null : ` · refreshed ${generatedAt}`}
          </p>
          <InstallationScopePicker scope={scope} onChange={handleScopeChange} />
        </div>
        <StatsControls selection={selection} onChange={setSelection} />
      </header>
      {query.isError ? (
        <FeatureError
          message={query.error instanceof Error ? query.error.message : "Unable to load stats."}
        />
      ) : null}
      {query.isPending ? <FeatureSkeleton label="Adding up the numbers…" /> : null}
      {overview === null ? null : (
        <div className="stats-grid">
          <InteractionHeadline overview={overview} />
          <InteractionsSection overview={overview} />
          <MessagesSection overview={overview} />
          <HourlySection overview={overview} />
          <ActionsSection overview={overview} />
          <TopQuestionsSection overview={overview} />
          <BoothBreakdownSection overview={overview} />
        </div>
      )}
    </GlassPanel>
  );
}
