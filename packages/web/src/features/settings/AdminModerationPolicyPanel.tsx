import type { JSX } from "react";
import { useEffect, useState } from "react";
import { ApiError, useModerationPolicy, useUpdateModerationPolicy } from "../../lib/api-client.js";
import { FeatureError } from "../common/FeatureStates.js";

const minPolicyLength = 50;

export function AdminModerationPolicyPanel(): JSX.Element {
  const policy = useModerationPolicy();
  const updatePolicy = useUpdateModerationPolicy();
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    if (policy.data) setInstructions(policy.data.instructions);
  }, [policy.data]);

  const trimmed = instructions.trim();
  const changed = policy.data ? trimmed !== policy.data.instructions : false;
  const valid = trimmed.length >= minPolicyLength;
  const errorMessage = updatePolicy.error
    ? updatePolicy.error instanceof ApiError
      ? updatePolicy.error.message
      : "The moderation policy could not be saved."
    : null;

  return (
    <section className="feature-card settings-moderation-policy">
      <div className="settings-account-heading">
        <div>
          <h2>AI moderation policy</h2>
          <p>
            Edit the instructions operator devices use when producing on-device moderation
            suggestions. Devices fall back to their bundled policy when this cannot be loaded.
          </p>
        </div>
        {policy.data ? (
          <span className="admin-badge" title="Active moderation policy version">
            v{policy.data.version} · {policy.data.source}
          </span>
        ) : null}
      </div>
      {policy.isLoading ? <p>Loading moderation policy…</p> : null}
      {policy.error ? <FeatureError message="The moderation policy could not be loaded." /> : null}
      {errorMessage ? <FeatureError message={errorMessage} /> : null}
      {policy.data ? (
        <>
          <dl className="debug-kv-grid debug-kv-grid--compact">
            <div>
              <dt>Source</dt>
              <dd>{policy.data.source}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{policy.data.version}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                {policy.data.updatedAt
                  ? new Date(policy.data.updatedAt).toLocaleString()
                  : "Bundled fallback"}
              </dd>
            </div>
          </dl>
          <label className="settings-policy-editor">
            Moderation instructions
            <textarea
              rows={12}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
            />
          </label>
          <p className="feature-muted">
            {trimmed.length.toLocaleString()} characters · minimum {minPolicyLength}
          </p>
          <div className="debug-button-row">
            <button
              className="feature-button"
              type="button"
              disabled={!changed || updatePolicy.isPending}
              onClick={() => setInstructions(policy.data.instructions)}
            >
              Reset
            </button>
            <button
              className="feature-button feature-button--primary"
              type="button"
              disabled={!changed || !valid || updatePolicy.isPending}
              onClick={() => updatePolicy.mutate({ instructions: trimmed })}
            >
              {updatePolicy.isPending ? "Saving…" : "Save moderation policy"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
