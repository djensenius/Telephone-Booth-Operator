# Getting started

You'll need:

- **Docker** (or another OCI runtime) for Postgres + Azurite.
- **Node 22** + **pnpm 9**. We pin both via `mise`.
- A reachable **Authentik** instance, or any other OIDC provider — see
  [`authentik-setup.md`](authentik-setup.md) or
  [`other-providers/`](other-providers/).

## 1. Install tooling

```sh
brew install mise              # or: curl https://mise.run | sh
git clone https://github.com/djensenius/Telephone-Booth-Operator.git
cd Telephone-Booth-Operator
mise install                   # installs Node 22 + pnpm 9 + just + …
pnpm install --frozen-lockfile
```

## 2. Start dependencies

```sh
docker compose up -d           # postgres on :5432, azurite on :10000
```

## 3. Configure

```sh
cp .env.example .env
# Edit AUTHENTIK_ISSUER, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET,
# AUTHENTIK_REDIRECT_URI, AUTHENTIK_REQUIRED_GROUP, SESSION_SECRET.
# Defaults for the local docker-compose stack work as-is.
```

`SESSION_SECRET` should be 64 hex chars; generate one with
`openssl rand -hex 32`.

## 4. Initialize the database

```sh
just db-migrate
just db-seed                   # sample questions + first-run prompt
```

## 5. Run the stack

```sh
just dev                       # api on :8787, web on :5173
```

Open <http://localhost:5173>, lift the receiver, and complete Authentik
login. You should land on the **Status** screen with your name in the
header banner.

## 6. Issue an API token for the phone client

Rotary digit **6** → Settings → API tokens → **Create**. Copy the
plaintext token (shown once) and paste it into the Rust client's
`/etc/phone-booth/config.toml`.

## Smoke test

- Status panel updates in near-real time when the phone client posts.
- Rotary digit **9** → **Debug** — connection chip shows green when the
  booth is reachable (Tailscale or LAN).
- Rotary digit **2** → **Pending messages** lists any uploads.

If anything misbehaves, [`troubleshooting.md`](troubleshooting.md) covers
the usual suspects.
