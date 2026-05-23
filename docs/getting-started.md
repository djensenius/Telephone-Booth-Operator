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

Open <http://localhost:5173>, choose **Sign in with Authentik**, and
complete login. You should land on the **Status** screen; `/about` stays
public for visitors who only need lore and credits.

## 6. User-visible operator flow

- Rotary digit **1** → **Status** shows on/off-hook state plus the last 50
  status snapshots. It uses WebSocket push when available and falls back
  to polling.
- Rotary digit **2** → **Messages** reviews recordings, supports filters,
  playback, downloads, detail view, local listened marks, and bulk delete.
- Rotary digit **3** → **Questions** uploads FLAC prompt audio, files prompt
  cards, previews audio, and retires prompts.
- Rotary digit **4** → **Tokens** issues API tokens. Copy the plaintext token
  immediately; it is shown once. See [`api-tokens.md`](api-tokens.md).
- Rotary digit **5** → **Settings** shows account details, logout, theme
  preferences, and the phone-client connection panel.
- Rotary digit **6** → **About** explains the booth design and project stack.
- Rotary digit **7** clears the operator session and returns to login.
- Rotary digit **9** → **Debug** opens the phone-client diagnostics panel.

Paste issued phone-client tokens into the Rust client's
`/etc/phone-booth/config.toml`.

## Smoke test

- Status panel updates in near-real time when the phone client posts.
- Rotary digit **4** → **Tokens** creates a token and shows it once.
- Rotary digit **9** → **Debug** — connection chip shows green when the
  booth is reachable (Tailscale or LAN). See [`debug-panel.md`](debug-panel.md)
  for setup and LAN certificate pinning.
- Rotary digit **2** → **Messages** lists any uploads.

If anything misbehaves, [`troubleshooting.md`](troubleshooting.md) covers
the usual suspects.
