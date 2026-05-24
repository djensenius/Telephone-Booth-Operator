/**
 * Seed script wrapper.
 *
 * Re-run with `just db-seed` or
 * `pnpm --filter @telephone-booth-operator/api exec tsx scripts/seed.ts`.
 */
await import("../packages/api/scripts/seed.ts");
