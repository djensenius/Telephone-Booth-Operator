-- Track the running `telephone-booth` Rust client version with each
-- observability event and on the derived call session. Nullable so the
-- backfill of pre-existing rows stays a single `ALTER TABLE` instead of
-- requiring an "unknown" sentinel.

ALTER TABLE "BoothEvent" ADD COLUMN "version" TEXT;
ALTER TABLE "CallSession" ADD COLUMN "version" TEXT;
