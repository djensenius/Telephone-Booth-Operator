-- Add a `runtimeMode` enum column to `BoothStatusSnapshot` so the operator
-- can persist (and later display) whether a booth was running with real Pi
-- adapters, the in-memory mock adapters, or the interactive simulator TUI.
-- The booth stamps every `PUT /v1/status` payload with this field; the UI
-- renders a `MOCK` / `SIM` badge so non-production booths are obvious at a
-- glance. Nullable for backward compatibility with older booth firmware.

CREATE TYPE "RuntimeMode" AS ENUM ('real', 'mock', 'simulator');

ALTER TABLE "BoothStatusSnapshot"
ADD COLUMN "runtimeMode" "RuntimeMode";
