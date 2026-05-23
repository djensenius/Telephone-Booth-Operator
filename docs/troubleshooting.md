# Troubleshooting

## "Operator credentials required" — I can log in but I'm bounced

You're authenticated with the OIDC provider but you're not in the
required group. Add yourself to `telephone-booth-operators` (Authentik)
or whatever you set as `OIDC_REQUIRED_GROUP`. Or set
`OIDC_REQUIRED_GROUP=""` and `OIDC_ALLOWED_EMAILS=you@example.com` for a
single-user install — see [`other-providers/google.md`](other-providers/google.md).

## OIDC callback fails with `invalid_redirect_uri`

The redirect URI registered with your IdP doesn't match what the
operator backend is sending. Check `AUTHENTIK_REDIRECT_URI` (or
`OIDC_REDIRECT_URI`) against the URI list in your IdP's client config.
Trailing slashes matter.

## ID token validates but `groups: []`

Your IdP isn't including the groups claim. See the provider-specific
fix in [`other-providers/`](other-providers/) — usually a custom property
mapping / mapper / Action.

## WebSocket disconnects every ~60 s

Reverse proxy idle timeout. For nginx, raise
`proxy_read_timeout 3600s;` on the `/v1/ws/` location. For Caddy, the
default is fine; check that you've used `reverse_proxy` (which handles
WS), not `redir`.

## "LINE BUSY" placard keeps dropping

That's the WebSocket-disconnect overlay. Either the API container
restarted, your network blew up, or your reverse proxy timed the WS out
(above). Check `docker compose logs api` for restarts.

## Recordings show as "Content missing"

The DB has a `File` row but the blob is gone. Either:
- Blob was deleted out of band — restore from Azure backup or accept
  the loss.
- Connection string points at the wrong container or account in this
  environment (e.g. staging DB joined to prod blobs). Cross-check
  `AZURE_BLOB_CONTAINER` and the container's URL.

## Recordings play but sound silent or garbled

- Wrong sample rate negotiated by the Web Audio FLAC decoder — should
  be `48000`. Check the headers Azure returned with `curl -I "<download
  SAS URL>"`; `Content-Type` must be `audio/flac` (or
  `application/octet-stream`, which the UI also handles).
- Browser cache stuck. Hard refresh.

## Debug tab can't reach the booth

- **"Tailscale"** chip but no data → the booth's debug Bearer token is
  wrong. Re-copy from `/etc/phone-booth/debug-token` on the Pi and paste
  into Settings → Debug.
- **"LAN"** chip and a TLS warning → the self-signed cert was
  regenerated. Re-pin the fingerprint.
- **Both** dead → check the booth: `journalctl -u telephone-booth -e`.

## Tokens page is empty after creation

Tokens are listed by their `last4`; you'll see them after a hard refresh
(TanStack Query refetches). If they really don't show up, the DB write
failed — check `docker compose logs api`.

## `pnpm install` fails after pulling latest

Lockfile version may have shifted. Run `pnpm install --no-frozen-lockfile`
once to refresh, commit the resulting `pnpm-lock.yaml`. CI uses
`--frozen-lockfile` so the lockfile must be authoritative.
