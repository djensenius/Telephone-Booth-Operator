# Telephone-Booth-Operator

> _"This is Bell Canada calling. Please hold for the operator."_

The operator console for the **Telephone-Booth** art installation — a soft-red,
glass-and-aluminum web app themed after an iconic 1980s Bell Canada outdoor
booth, with a Northern Electric **Contempra** rotary phone tucked inside that
doubles as the navigation.

The booth answers, the operator approves, the call goes through.

```text
            ╔═══════════════════════╗
            ║   📞  T E L E P H O N E ║
            ╠═══════════════════════╣
            ║                       ║
            ║     ┌─────────┐       ║
            ║     │  ◐ ◐ ◐  │       ║   ← live status lamps
            ║     │ ─────── │       ║
            ║     │ ╭─────╮ │       ║
            ║     │ │  ⊙  │ │       ║   ← Contempra phone (rotary nav)
            ║     │ ╰─────╯ │       ║
            ║     └─────────┘       ║
            ║                       ║
            ║   [COIN RETURN]       ║
            ╚═══════════════════════╝
```

## What lives here

| Package           | What it is                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `packages/api`    | Hono backend (Node), Prisma + Postgres, Authentik OIDC, WebSocket    |
| `packages/web`    | React + Vite + TypeScript frontend, themed shell, rotary dial nav    |
| `packages/shared` | Zod schemas + generated TS types shared by `api` and `web`           |
| `docs/`           | Architecture, setup, theme, runbooks, ADRs, provider guides          |
| `tools/seed.ts`   | Idempotent seed (sample questions + first-run operator instructions) |

The phone-side client lives in a separate repo,
[`Telephone-Booth`](https://github.com/djensenius/Telephone-Booth), on the
`rust-client` branch. The two communicate over a versioned `/v1` REST + WebSocket
API defined by `packages/api/openapi.yaml`.

## Quickstart

```sh
mise install                       # node 24 + pnpm 9
vp install --frozen-lockfile
cp .env.example .env               # then edit AUTHENTIK_* values
docker compose up -d               # postgres + azurite
just db-migrate
just db-seed
just dev                           # api on :8787, web on :5173
```

Open <http://localhost:5173>, lift the receiver, and finish the OIDC login.

## Authentication

The operator UI is gated behind **Authentik OIDC** by default. Group-based
authorization means you grant access by adding people to the
`telephone-booth-operators` group in Authentik — no code changes, no separate
user database.

- **Default provider:** [Authentik](https://goauthentik.io) —
  see [`docs/authentik-setup.md`](docs/authentik-setup.md).
- **Other providers:** Any OIDC-compliant provider works. We document
  Keycloak, Auth0, Google, Dex, and generic OIDC in
  [`docs/other-providers/`](docs/other-providers/).

The phone-side Rust client authenticates with a **static Bearer API token**
issued from the operator UI (Settings → API tokens). Tokens are stored hashed
and shown only once on creation.

## Documentation

| Doc                                                  | When you need it                                   |
| ---------------------------------------------------- | -------------------------------------------------- |
| [`docs/getting-started.md`](docs/getting-started.md) | First-time setup                                   |
| [`docs/architecture.md`](docs/architecture.md)       | How the pieces fit together                        |
| [`docs/authentik-setup.md`](docs/authentik-setup.md) | Wire up Authentik, step-by-step                    |
| [`docs/other-providers/`](docs/other-providers/)     | Use Keycloak / Auth0 / Google / Dex / any OIDC IdP |
| [`docs/theme.md`](docs/theme.md)                     | Bell Canada visual system + accessibility          |
| [`docs/azure-storage.md`](docs/azure-storage.md)     | Azure Blob layout, SAS scoping, Azurite for dev    |
| [`docs/deployment.md`](docs/deployment.md)           | Production deploy via container images             |
| [`docs/runbook.md`](docs/runbook.md)                 | Day-2: rotate secrets, restore from backup         |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | When the receiver buzzes                           |

Full index: [`docs/README.md`](docs/README.md).

## Related repositories

The Telephone Booth art installation spans several repos:

| Repo                                                                                               | What it is                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`Telephone-Booth`](https://github.com/djensenius/Telephone-Booth)                                 | Rust phone client running on a Pi inside the booth.                             |
| [`Telephone-Booth-Operator`](https://github.com/djensenius/Telephone-Booth-Operator)               | Hono + React operator console (this repo).                                      |
| [`Telephone-Booth-Operator-Mobile`](https://github.com/djensenius/Telephone-Booth-Operator-Mobile) | Native Swift/SwiftUI operator app for iOS, macOS, watchOS, visionOS, and tvOS.  |
| [`Telephone-Booth-Transcription`](https://github.com/djensenius/Telephone-Booth-Transcription)     | macOS app exposing an OpenAI-compatible local transcription and moderation API. |

## License

Apache-2.0 — same as the original `Telephone-Booth` project.
