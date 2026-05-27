// Operator-facing usage stats screen. Reads aggregated counters from
// `/v1/stats/overview`; the API is responsible for time-window bucketing
// (all in UTC) and we reformat for the local operator here.

import { useMemo, useState } from "react";
import { STATS_WINDOW_VALUES } from "@telephone-booth-operator/shared";
import type { StatsOverview, StatsWindow } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useStatsOverview } from "../../lib/api-client.js";
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

const STATUS_ORDER: readonly string[] = ["uploading", "received", "pending", "approved", "rejected"];

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

function CallsSection({ overview }: OverviewProps): JSX.Element {
  const { calls } = overview;
  const completionRate = calls.total > 0 ? calls.completed / calls.total : null;
  const outcomes = orderRecord(calls.outcomes, OUTCOME_ORDER, OUTCOME_LABEL);
  const maxOutcome = outcomes.reduce((max, row) => Math.max(max, row.value), 0);
  const maxPerDay = calls.perDay.reduce((max, day) => Math.max(max, day.total), 0);
  return (
    <GlassPanel title="Calls" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Calls</h2>
        <p>
          {fmtNumber(calls.total)} pickups · {fmtNumber(calls.completed)} completed ·{" "}
          {fmtPercent(completionRate)} completion
        </p>
      </header>
      <div className="stats-tiles">
        <SummaryTile label="In progress now" value={fmtNumber(calls.inProgress)} />
        <SummaryTile
          label="Avg duration"
          value={fmtDurationMs(calls.averageDurationMs)}
          hint="completed calls"
        />
        <SummaryTile label="Longest call" value={fmtDurationMs(calls.longestDurationMs)} />
      </div>
      <h3>Outcomes</h3>
      {outcomes.length === 0 ? (
        <p className="stats-empty">No completed calls yet.</p>
      ) : (
        <div className="stats-bars">
          {outcomes.map((row) => (
            <BarRow key={row.key} label={row.label} value={row.value} max={maxOutcome} />
          ))}
        </div>
      )}
      <h3>Calls per day (UTC)</h3>
      {calls.perDay.length === 0 ? (
        <p className="stats-empty">No data in this window.</p>
      ) : (
        <div className="stats-bars stats-bars--days">
          {calls.perDay.map((day) => (
            <BarRow
              key={day.date}
              label={fmtDateShort(day.date)}
              value={day.total}
              max={maxPerDay}
              trailing={`${day.total} · ${day.completed} ✔`}
            />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

function MessagesSection({ overview }: OverviewProps): JSX.Element {
  const { messages, playback } = overview;
  const statuses = orderRecord(messages.byStatus, STATUS_ORDER, STATUS_LABEL);
  const maxStatus = statuses.reduce((max, row) => Math.max(max, row.value), 0);
  return (
    <GlassPanel title="Messages" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Messages</h2>
        <p>
          {fmtNumber(messages.total)} left · avg {fmtDurationMs(messages.averageDurationMs)} ·{" "}
          {fmtNumber(playback.totalPlaybacks)} booth playbacks
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
  const maxCalls = hourly.reduce((max, b) => Math.max(max, b.calls), 0);
  return (
    <GlassPanel title="Hourly activity" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Hour of day</h2>
        <p>
          Busiest hour: {fmtHour(busiest.hour)}
          {busiest.dayOfWeek === null ? null : ` · ${DAY_OF_WEEK_LABEL[busiest.dayOfWeek]}`}
        </p>
      </header>
      <div className="stats-heatmap" role="img" aria-label="Calls per UTC hour">
        {hourly.map((bucket) => {
          const intensity = maxCalls > 0 ? bucket.calls / maxCalls : 0;
          return (
            <div
              key={bucket.hour}
              className="stats-heatmap__cell"
              title={`${bucket.hour}:00 UTC — ${bucket.calls} calls, ${bucket.messages} messages`}
              style={{ opacity: 0.2 + intensity * 0.8 }}
            >
              <span className="stats-heatmap__hour">{bucket.hour}</span>
              <span className="stats-heatmap__count">{bucket.calls}</span>
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}

function PickupsHangupsSection({ overview }: OverviewProps): JSX.Element {
  const { pickupsHangups, uploads, lastActivityAt } = overview;
  const digits = Array.from({ length: 10 }, (_, i) => ({
    digit: String(i),
    count: pickupsHangups.digitsDialed[String(i)] ?? 0,
  }));
  const maxDigit = digits.reduce((max, d) => Math.max(max, d.count), 0);
  return (
    <GlassPanel title="Pickups & hangups" className="stats-panel">
      <header className="stats-panel__header">
        <h2>Pickups & hangups</h2>
        <p>
          {fmtNumber(pickupsHangups.pickups)} pickups · {fmtNumber(pickupsHangups.hangups)} hangups
        </p>
      </header>
      <div className="stats-tiles">
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
        <p>Sorted by number of messages received in this window.</p>
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
            <th scope="col">Calls</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {boothBreakdown.map((b) => (
            <tr key={b.boothId}>
              <th scope="row">{b.boothId}</th>
              <td>{fmtNumber(b.calls)}</td>
              <td>{fmtTimeAgo(b.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  );
}

export function StatsScreen(): JSX.Element {
  const [windowChoice, setWindowChoice] = useState<StatsWindow>("7d");
  const query = useStatsOverview(windowChoice);
  const overview = query.data ?? null;

  const generatedAt = useMemo(
    () => (overview ? new Date(overview.generatedAt).toLocaleString() : null),
    [overview],
  );

  return (
    <article className="stats-screen" aria-labelledby="stats-title">
      <header className="stats-screen__header">
        <div>
          <span className="screen-kicker">Operator console</span>
          <h1 id="stats-title">Usage statistics</h1>
          <p className="stats-screen__subtitle">
            {WINDOW_LABEL[windowChoice]}
            {generatedAt === null ? null : ` · refreshed ${generatedAt}`}
          </p>
        </div>
        <fieldset className="stats-window-picker" aria-label="Window">
          <legend className="visually-hidden">Time window</legend>
          {STATS_WINDOW_VALUES.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="stats-window"
                value={option}
                checked={windowChoice === option}
                onChange={() => setWindowChoice(option)}
              />
              <span>{WINDOW_LABEL[option]}</span>
            </label>
          ))}
        </fieldset>
      </header>
      {query.isError ? (
        <FeatureError
          message={query.error instanceof Error ? query.error.message : "Unable to load stats."}
        />
      ) : null}
      {query.isPending ? <FeatureSkeleton label="Adding up the numbers…" /> : null}
      {overview === null ? null : (
        <div className="stats-grid">
          <CallsSection overview={overview} />
          <MessagesSection overview={overview} />
          <HourlySection overview={overview} />
          <PickupsHangupsSection overview={overview} />
          <TopQuestionsSection overview={overview} />
          <BoothBreakdownSection overview={overview} />
        </div>
      )}
    </article>
  );
}
