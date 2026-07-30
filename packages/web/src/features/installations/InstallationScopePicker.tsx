import type { JSX } from "react";
import { useMemo } from "react";
import { INSTALLATION_SCOPE_ALL, InstallationScopeSchema } from "@telephone-booth-operator/shared";
import type { Installation, InstallationScope } from "@telephone-booth-operator/shared";
import { useInstallationsList } from "../../lib/api-client.js";

// Parse an `installationId=…` search-param value into an `InstallationScope`,
// returning undefined for anything else (missing, malformed, wrong type). The
// screens use this to round-trip the scope through the URL.
export function parseInstallationScopeParam(raw: unknown): InstallationScope | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parsed = InstallationScopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// Names are not unique — two runs of the same festival can share one — so an
// option carries the era's start date as a discriminator. The active era says
// so instead, since there is only ever one of those.
function optionLabel(installation: Installation): string {
  if (installation.isActive) return `${installation.name} (active)`;
  const started = new Date(installation.startedAt);
  const stamp = Number.isNaN(started.getTime())
    ? installation.startedAt
    : started.toLocaleDateString();
  // The date alone is not enough: two runs of the same name can start on the
  // same day, so the head of the id is what actually makes the option unique.
  return `${installation.name} — started ${stamp} (${installation.id.slice(0, 8)})`;
}

// Whether the selected scope is an era whose counters are frozen. "All" spans
// open and closed eras, so it is not treated as frozen; the API is the thing
// that actually refuses a write against a closed one.
export function useScopeIsFrozen(scope: InstallationScope | undefined): boolean {
  const listQuery = useInstallationsList();
  if (scope === undefined || scope === INSTALLATION_SCOPE_ALL) return false;
  const match = (listQuery.data?.items ?? []).find((item) => item.id === scope);
  return match !== undefined && !match.isActive;
}

// Shared installation-scope selector used by the observability screens
// (messages, sessions, events) and the stats screen. Rendering "Active
// installation" as the default matches the API's own default (no scope =
// active era) so the URL stays clean until the operator picks a specific era.
export function InstallationScopePicker({
  scope,
  onChange,
  label = "Installation",
  id,
}: {
  readonly scope: InstallationScope | undefined;
  readonly onChange: (next: InstallationScope | undefined) => void;
  readonly label?: string;
  readonly id?: string;
}): JSX.Element {
  const listQuery = useInstallationsList();
  const installations = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    return [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [listQuery.data]);

  const value = scope ?? "";

  return (
    <label className="stats-scope-picker" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === "") return onChange(undefined);
          if (next === INSTALLATION_SCOPE_ALL) return onChange(INSTALLATION_SCOPE_ALL);
          onChange(next);
        }}
      >
        <option value="">Active installation</option>
        {installations.map((installation) => (
          <option key={installation.id} value={installation.id}>
            {optionLabel(installation)}
          </option>
        ))}
        <option value={INSTALLATION_SCOPE_ALL}>All installations</option>
      </select>
    </label>
  );
}
