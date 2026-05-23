import type { BoothStatus, TelemetryRecord } from "../../lib/debug-client.js";

export interface StateTransitionRow {
  readonly id: number;
  readonly ts: string;
  readonly from: string;
  readonly to: string;
  readonly cause: string;
}

export interface StateMachinePanelProps {
  readonly status: BoothStatus | undefined;
  readonly transitions: readonly StateTransitionRow[];
}

function stateCopy(state: string | undefined): string {
  if (state === undefined) {
    return "Line is quiet";
  }
  return state.replaceAll("_", " ");
}

export function transitionFromRecord(record: TelemetryRecord): StateTransitionRow | null {
  if (record.kind !== "state_transition") {
    return null;
  }
  return {
    id: record.id,
    ts: record.ts,
    from: record.from,
    to: record.to,
    cause: record.cause,
  };
}

export function StateMachinePanel({ status, transitions }: StateMachinePanelProps): JSX.Element {
  const latestTransition = transitions[0];
  return (
    <section className="debug-panel" aria-labelledby="debug-state-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">State machine</p>
        <h2 id="debug-state-heading">Switchboard state</h2>
      </div>
      <dl className="debug-kv-grid">
        <div>
          <dt>Current state</dt>
          <dd>{stateCopy(status?.state)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{status?.updatedAt ?? "—"}</dd>
        </div>
        <div>
          <dt>Question</dt>
          <dd>{status?.currentQuestionId ?? "none"}</dd>
        </div>
        <div>
          <dt>Message</dt>
          <dd>{status?.currentMessageId ?? "none"}</dd>
        </div>
      </dl>
      {status?.lastError === null || status?.lastError === undefined ? null : <p className="debug-callout">Last error: {status.lastError}</p>}
      <p className="sr-only" aria-live="polite">
        {latestTransition === undefined ? "No state transitions yet" : `State changed from ${latestTransition.from} to ${latestTransition.to}`}
      </p>
      <div className="debug-table-wrap" tabIndex={0} aria-label="Last 50 state transitions">
        <table className="debug-table">
          <caption>Last 50 transitions</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Cause</th>
            </tr>
          </thead>
          <tbody>
            {transitions.length === 0 ? (
              <tr>
                <td colSpan={4}>Awaiting first transition.</td>
              </tr>
            ) : (
              transitions.map((transition) => (
                <tr key={transition.id}>
                  <td>{transition.ts}</td>
                  <td>{stateCopy(transition.from)}</td>
                  <td>{stateCopy(transition.to)}</td>
                  <td>{transition.cause}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
