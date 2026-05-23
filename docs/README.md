# Telephone-Booth-Operator — documentation

This index is the source of truth for the docs tree. `just docs-index`
rebuilds it from the filesystem; CI fails if it drifts.

## For first-time setup

- [Getting started](getting-started.md) — clone → install → seed → log in

## Authentication

- [Authentik setup](authentik-setup.md) — full Authentik walkthrough (default provider)
- [Other providers](other-providers/) — Keycloak / Auth0 / Google / Dex / generic OIDC

## Inside the box

- [Architecture](architecture.md) — Hono + Prisma + Postgres + Azure overview
- [API](api/README.md) — reading and regenerating `openapi.yaml`
- [Azure storage](azure-storage.md) — container layout, SAS scoping, Azurite for dev
- [Theme](theme.md) — Bell Canada visual system, components, accessibility
- [UI routing](ui-routing.md) — rotary digit ↔ route map, keyboard nav, reduced motion

## Running it

- [Deployment](deployment.md) — building images, env, secrets, reverse proxy
- [Runbook](runbook.md) — day-2 ops
- [Troubleshooting](troubleshooting.md)

## For contributors

- [Contributing](contributing.md)

## ADRs

- [0001 — React + Vite + Hono + Prisma](adr/0001-react-vite-hono-prisma.md)
- [0002 — Authentik OIDC](adr/0002-authentik-oidc.md)
- [0003 — Azure Blob with SAS uploads](adr/0003-azure-blob-with-sas-uploads.md)
- [0004 — Postgres with Prisma](adr/0004-postgres-with-prisma.md)
