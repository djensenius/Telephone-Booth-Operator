# ADR 0001 — React + Vite + Hono + Prisma

**Status:** accepted.

## Context

The legacy operator was AngularJS-Material + Pug + Express + Mongoose. It
ran fine but the framework versions are long past EoL and we want a
stack that's pleasant in 2026.

## Decision

| Layer    | Choice            | Why                                                                                            |
| -------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| Frontend | React + Vite + TS | Universally familiar; fast dev server; great TS story; ecosystem of every component we'd need. |
| Routing  | TanStack Router   | Type-safe routes, great with the rotary-as-nav shape.                                          |
| Data     | TanStack Query    | Caching + WS-driven invalidation patterns we already need.                                     |
| Backend  | Hono on Node      | Tiny, fast, type-safe; can move to Bun/Workers later without rewriting handlers.               |
| ORM      | Prisma            | Schema-as-source-of-truth, migrations, generated client.                                       |
| DB       | Postgres          | Boring + reliable. Open file types, no proprietary lock-in.                                    |

## Consequences

**Good:**

- Hono's first-class TS + middleware story makes auth/OIDC code clean.
- Prisma migrations are the source of schema truth, version-controlled.
- Both halves can deploy as small containers.

**Trade-offs:**

- Two languages in the repo (TS for frontend, TS for backend) — same
  ecosystem at least.
- Prisma generates a client into `node_modules` that must be regenerated
  on schema change; CI runs `prisma generate` in the build.
