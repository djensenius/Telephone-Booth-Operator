import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../../lib/debug-client.js";

export interface LogsPanelProps {
  readonly logs: readonly LogEntry[];
  readonly level: string;
  readonly onLevelChange: (level: string) => void;
}

const LEVELS = ["all", "error", "warn", "info", "debug", "trace"] as const;

export function LogsPanel({ logs, level, onLevelChange }: LogsPanelProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [autoTail, setAutoTail] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filteredLogs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = needle.length === 0 ? logs : logs.filter((entry) => `${entry.level} ${entry.target} ${entry.message}`.toLowerCase().includes(needle));
    return matches.slice(-200);
  }, [logs, search]);

  useEffect(() => {
    if (autoTail && listRef.current !== null) {
      if (typeof listRef.current.scrollTo === "function") {
        listRef.current.scrollTo({ top: listRef.current.scrollHeight });
      } else {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    }
  }, [autoTail, filteredLogs.length]);

  return (
    <section className="debug-panel" aria-labelledby="debug-logs-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">Logs</p>
        <h2 id="debug-logs-heading">Operator logbook</h2>
      </div>
      <div className="debug-filters">
        <label>
          Level
          <select value={level} onChange={(event) => onLevelChange(event.currentTarget.value)}>
            {LEVELS.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="busy, hook, upload" />
        </label>
        <label className="debug-checkbox">
          <input type="checkbox" checked={autoTail} onChange={(event) => setAutoTail(event.currentTarget.checked)} />
          Auto-tail
        </label>
      </div>
      <div className="debug-log-list" ref={listRef} role="log" aria-live={autoTail ? "polite" : "off"} tabIndex={0}>
        {filteredLogs.length === 0 ? (
          <p>No log entries match this filter.</p>
        ) : (
          filteredLogs.map((entry) => (
            <article className={`debug-log-entry debug-log-entry--${entry.level}`} key={`${entry.ts}-${entry.target}-${entry.message}`}>
              <time>{entry.ts}</time>
              <strong>{entry.level}</strong>
              <span>{entry.target}</span>
              <p>{entry.message}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
