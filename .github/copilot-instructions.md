# Copilot instructions — Telephone-Booth-Operator

> _"This is Bell Canada calling. Please hold for the operator."_

These instructions tell GitHub Copilot (and any other AI assistant) how to work
inside this repository. Read them in full before proposing changes.

## Authoring & attribution rules (read first)

- **Never add AI co-authors.** Do **not** add `Co-authored-by: Copilot …`,
  `Co-authored-by: GitHub Copilot …`, or any other AI/LLM/bot `Co-authored-by:`
  trailer to commits, PR descriptions, or merge commits. Same rule for
  `Signed-off-by:` lines naming an AI. The human running the tool is the sole
  author.
- **Do not mention AI assistance in commit messages, PR titles, PR bodies, or
  changelog entries.** No "generated with Copilot", "written by AI", etc.
- **Do not invent attributions, names, emails, or issue/PR numbers.** If a real
  number isn't available, omit the reference.
- **Wait for Copilot PR review before merging.** Do not merge until the
  Copilot PR review has completed, all actionable Copilot feedback is addressed,
  and false positives have a reply explaining why they are not being changed.
- Keep commit messages factual and human-voiced; prefer Conventional Commits
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) but they are not
  strictly enforced. See [`docs/contributing.md`](../docs/contributing.md).
- Branch naming: `<github-username>/<short-topic>` (e.g. `djensenius/rotary-haptics`).
- Never commit secrets, real tokens, real client IDs, real SAS URLs, or anything
  from a real `.env`. Only touch `.env.example` for new variables, and use
  obviously-fake placeholder values.

## What this repo is

The operator console for the **Telephone-Booth** art installation — a themed
React web app + Hono API that pair with a Rust phone client living in the
separate [`Telephone-Booth`](https://github.com/djensenius/Telephone-Booth)
repository (`rust-client` branch). The two sides communicate over a versioned
`/v1` REST + WebSocket API defined by [`packages/api/openapi.yaml`](../packages/api/openapi.yaml).

### Workspace layout

| Path              | Contents                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `packages/api`    | Hono backend on Node, Prisma + Postgres, Authentik OIDC, WebSocket |
| `packages/web`    | React 18 + Vite + TS, TanStack Router/Query, themed booth shell    |
| `packages/shared` | Zod schemas + generated TS types shared by `api` and `web`         |
| `tools/`          | One-off scripts (seed, docs index generator)                       |
| `docs/`           | Architecture, setup, theme, runbooks, ADRs, provider guides        |

This is a **pnpm workspace** (`pnpm@9.15.0`) on **Node 24** with the **Vite+**
toolchain. Use `vp` for install/dev/build/test/lint/format workflows; use raw
`pnpm` only for package-manager-specific operations. Tool versions are pinned in
`mise.toml` and `.node-version` — run `mise install` to get them.

## Tech stack & key conventions

- **Language:** TypeScript with `strict: true` everywhere. **No `any`.** Prefer
  `unknown` plus narrowing, discriminated unions, and Zod parsing at trust
  boundaries.
- **Modules:** ESM only (`"type": "module"`). Use named exports; default
  exports only where a framework requires them.
- **Imports:** use `import type { … }` for type-only imports. Unused vars must
  be prefixed with `_` or removed.
- **Backend:** Hono on `@hono/node-server`. Routes live in
  `packages/api/src/routes/` grouped per resource. Validate request bodies and
  query params with Zod (via `@hono/zod-validator`) sourced from
  `@telephone-booth-operator/shared` whenever the shape is wire-visible.
- **Database:** Prisma + Postgres. Schema is the source of truth in
  `packages/api/prisma/schema.prisma`. Generate a migration with
  `prisma migrate dev`; never hand-edit migration SQL after it has shipped.
- **Frontend:** React 18 function components only — **no class components**.
  Routing is TanStack Router, data is TanStack Query. Wrap screen bodies in
  `<GlassPanel>` to keep the theme consistent.
- **Styling:** Design tokens from `packages/web/src/styles/theme.css` only.
  **No raw hex codes** in component CSS — reference CSS variables. Respect the
  Bell-Canada visual system described in [`docs/theme.md`](../docs/theme.md)
  and `prefers-reduced-motion`.
- **Shared types:** Zod schemas in `packages/shared` are the runtime source of
  truth. `packages/api/openapi.yaml` is the typing source of truth for the
  browser fetch client (`packages/web/src/api/schema.gen.ts`). When you change
  one you almost always have to update the other — run `just openapi-gen`
  after editing `openapi.yaml`.
- **Logging:** Pino on the backend (`pino`). Do not `console.log` in API code
  (frontend may use `console` for dev diagnostics, but prefer the existing
  debug panel — see [`docs/debug-panel.md`](../docs/debug-panel.md)).
- **Errors:** throw typed errors that the central Hono error handler maps to
  RFC 7807 problem responses. Never leak Prisma errors, stack traces, or raw
  Authentik responses to clients.
- **Async:** `await` everything; do not float promises. Tests must `await`
  their assertions.

## Security & auth (do not regress)

The operator UI is gated behind **Authentik OIDC** with group-based
authorization (`AUTHENTIK_REQUIRED_GROUP`, default `telephone-booth-operators`).
The phone-side Rust client authenticates with a **static Bearer API token**
hashed at rest with Argon2id.

When touching auth, security, or storage code:

- Keep the **OIDC nonce, state, and PKCE `code_verifier`** flow intact. Never
  log or expose them.
- Session cookies must remain `__Host-`-prefixed, `HttpOnly`,
  `SameSite=Lax`, and `Secure` outside localhost. Do not weaken these.
- Refresh tokens are encrypted at rest. New token columns follow the same
  pattern — never store OAuth tokens in plaintext.
- API tokens are Argon2id-hashed. The plaintext is shown to the operator
  exactly once on creation. Do not add endpoints that return it again.
- Azure Blob access is via short-lived SAS URLs scoped to a specific blob
  path. Do not broaden SAS scope or lifetime without an ADR.
- Files are content-addressed by SHA-256. Preserve dedupe behaviour when
  editing upload code.
- The WebSocket at `/v1/ws/status` is cookie-authenticated. Unauthenticated
  clients are closed with policy violation `1008`. Do not bypass.
- Any new env var must be added to `.env.example` with a placeholder and
  documented (typically in `docs/` and/or the relevant provider guide).

See [`docs/architecture.md`](../docs/architecture.md),
[`docs/sessions.md`](../docs/sessions.md), and
[`docs/api-tokens.md`](../docs/api-tokens.md).

## Adding things — recipes

### A new API endpoint

1. Edit `packages/api/openapi.yaml` **first**. Prefer landing the spec change
   as its own PR to surface API-design feedback early.
2. Implement the handler in `packages/api/src/routes/`. Validate inputs with
   the shared Zod schema; reuse error helpers.
3. Run `just openapi-gen` to regenerate `packages/web/src/api/schema.gen.ts`.
4. Wire up the frontend through TanStack Query.
5. Add Vitest coverage for at least one happy path and one auth-failure path.

### A new screen

1. Add the route to `packages/web/src/app/router.ts`.
2. If reachable via the rotary dial, update both
   [`docs/ui-routing.md`](../docs/ui-routing.md) and the key map in
   `packages/web/src/features/booth/RotaryDial.tsx`.
3. Wrap the screen body in `<GlassPanel>`.

### A new OIDC provider

1. Add `docs/other-providers/<provider>.md` matching the existing structure.
2. Link it from `docs/other-providers/README.md` and `docs/README.md`.
3. Quirks go behind an env-var feature flag in
   `packages/api/src/lib/auth.ts`, documented in the guide and `.env.example`.

### A new database field

1. Update `packages/api/prisma/schema.prisma`.
2. Generate a migration with `prisma migrate dev --name <short-name>`.
3. Update the seed (`tools/seed.ts`) and any Zod schemas if the field is
   exposed on the wire.

## Commands you should actually use

Use `just` (the workspace task runner). Generated and verified recipes:

```sh
just setup          # vp install --frozen-lockfile
just dev            # docker compose up -d  +  vp run -r --parallel dev
just down           # docker compose down
just db-migrate     # prisma migrate dev
just db-seed        # tsx tools/seed.ts via the api package
just typecheck      # vp run -r typecheck
just lint           # vp run -r lint + markdownlint
just fmt            # vp fmt
just test           # Vite+ tests across the workspace
just check          # fmt + lint + typecheck + test  (run before pushing)
just docs-check     # markdownlint + lychee link check
just openapi-gen    # regenerate the typed web API client
just e2e            # playwright e2e (needs running stack)
just docker-build   # build prod images locally
```

Equivalent Vite+ scripts exist (`vp run lint`, `vp run test`, `vp run typecheck`,
`vp run build`) and are what CI runs. Prefer the `just` recipes locally.

Lint warnings break the build, so fix them, don't ignore them.

## Testing

- **Unit/integration:** Vitest. Co-locate `*.test.ts` next to source, or use
  `test/` for fixtures. Frontend uses `@testing-library/react`,
  `msw` for network mocks, and `axe-core` for a11y assertions.
- **E2E:** Playwright (`just e2e`) — only runs against a live stack.
- New behaviour needs a test. Bug fixes should land with a regression test
  that fails before the fix.
- Don't mock the thing under test. Do mock external services (Authentik,
  Azure Blob) — Azurite is already available locally for blob storage.

## Documentation

- User-facing or architectural changes need a doc update in `docs/`. The
  index lives in [`docs/README.md`](../docs/README.md); add new pages there.
- Markdown is linted with `markdownlint-cli2` and link-checked with `lychee`
  (`just docs-check`). Use relative links between docs.
- ADRs go under `docs/adr/` and follow the format already in that folder.

## Things to avoid

- Adding `npm`/`yarn` lockfiles, scripts, or instructions. This is a pnpm
  workspace.
- Pulling in heavy new dependencies for small problems. Prefer the standard
  library, existing helpers, or a tiny utility.
- Disabling ESLint or TypeScript rules to make code compile. Fix the code.
- Catching errors only to rethrow them, or swallowing them silently.
- Loosening Prisma/Zod/Hono validators "just to make tests pass."
- Editing generated files by hand (`*.gen.ts`, `dist/`, Prisma client output).
- Re-formatting or rewriting unrelated code on the side. Keep diffs surgical.

## When in doubt

- Read [`docs/contributing.md`](../docs/contributing.md) and
  [`docs/architecture.md`](../docs/architecture.md).
- If a behaviour change is non-obvious or controversial, draft an ADR under
  `docs/adr/` before implementing.
- Run `just check` and `just docs-check` locally. If they pass and the diff
  is focused, the change is in good shape.
