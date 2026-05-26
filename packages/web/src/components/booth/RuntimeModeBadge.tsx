import type { BoothRuntimeMode } from "./BoothStatusContext.js";

const LABELS: Record<BoothRuntimeMode, string> = {
  real: "Live",
  mock: "MOCK",
  simulator: "SIM",
};

const TITLES: Record<BoothRuntimeMode, string> = {
  real: "This booth is running with real Pi hardware adapters.",
  mock: "This booth is running with in-memory mock adapters — no rotary phone is connected.",
  simulator: "This booth is being driven by the interactive simulator TUI.",
};

export interface RuntimeModeBadgeProps {
  readonly mode: BoothRuntimeMode | null | undefined;
  readonly className?: string;
}

// Compact pill that flags non-production booths. We only render anything for
// `mock` / `simulator` — a `real` booth is the default and shouldn't add
// chrome to every status panel. Returns null otherwise so callers can drop
// it inline next to a heading without conditional wrapping.
export function RuntimeModeBadge({ mode, className }: RuntimeModeBadgeProps): JSX.Element | null {
  if (mode == null || mode === "real") return null;
  const classes = ["runtime-mode-badge", `runtime-mode-badge--${mode}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      role="status"
      aria-label={`Booth runtime mode: ${mode}`}
      title={TITLES[mode]}
      data-mode={mode}
    >
      {LABELS[mode]}
    </span>
  );
}
