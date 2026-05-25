import type { RedactedConfig } from "../../lib/debug-client.js";

export interface ConfigPanelProps {
  readonly config: RedactedConfig | undefined;
}

export function ConfigPanel({ config }: ConfigPanelProps): JSX.Element {
  return (
    <section className="debug-panel" aria-labelledby="debug-config-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">Config</p>
        <h2 id="debug-config-heading">Effective redacted config</h2>
      </div>
      <details className="debug-details" open>
        <summary>Show JSON tree</summary>
        <pre className="debug-json" tabIndex={0}>
          {JSON.stringify(config ?? {}, null, 2)}
        </pre>
      </details>
    </section>
  );
}
