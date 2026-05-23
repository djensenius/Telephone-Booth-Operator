# ADR 0004 — Postgres with Prisma

**Status:** accepted.

## Context

Legacy used MongoDB via Mongoose. The data we actually have is
relational (questions ↔ messages ↔ files) and a relational store is
easier to back up, query ad hoc, and reason about migrations for.

## Decision

- **Postgres** for the operator DB.
- **Prisma** for the ORM + migration tooling.

## Consequences

**Good:**

- `prisma migrate` is the single source of schema-change history.
- Strongly typed query results in TS.
- Easy local dev via docker-compose.

**Trade-offs:**

- Prisma generates client code into `node_modules` — must be regenerated
  on every schema change. CI handles this; locally `prisma generate`
  runs automatically on `prisma migrate dev`.
- A future Bun/Workers move would need to swap Prisma for something
  edge-compatible (Drizzle, Kysely, …). Acceptable — handler-level
  code is portable.
