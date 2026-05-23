# Runbook (day-2 ops)

## Rotating `SESSION_SECRET`

> Logs everyone out.

```sh
openssl rand -hex 32 > new-session-secret
# Update the secret in your platform's store, then:
docker compose -f docker-compose.prod.yml up -d --force-recreate api
```

Operators redirect to Authentik on their next request and are back in
seconds later.

## Rotating the Authentik client secret

1. Authentik → Providers → `telephone-booth-operator` → **Regenerate
   client secret**.
2. Update `AUTHENTIK_CLIENT_SECRET` in your secrets store.
3. `docker compose ... up -d api` to roll the API container. Existing
   sessions survive because they're signed with `SESSION_SECRET`, not
   the OIDC secret.

## Rotating a phone-client API token

1. Operator UI → Settings → API tokens → **Create**.
2. Paste the new token into the Pi's `/etc/phone-booth/config.toml` and
   `systemctl restart telephone-booth`.
3. **Revoke** the old token in the operator UI.

If you skip the order and revoke first, the booth goes offline until you
restart it with the new token.

## Restoring Postgres

The operator DB is small (KB to a few MB). A nightly `pg_dump` is plenty:

```sh
# Backup
docker compose exec db pg_dump -U booth -Fc telephone_booth > backup.dump

# Restore
docker compose exec -T db pg_restore -U booth -d telephone_booth --clean < backup.dump
```

If you use a managed Postgres, lean on its point-in-time recovery and
skip the manual dumps.

## Restoring blob storage

Recordings are content-addressed by sha256 so duplicates are inherently
deduplicated. Restore from your Azure backup / soft-delete container.
Database rows that reference deleted blobs return `503 ContentMissing`
on read; the operator UI surfaces that clearly per message.

## Scaling

Realistically, one API and one web container handle every booth you're
ever likely to deploy. If you have dozens of operators looking at the
same booth concurrently and the WS broadcast load matters, the
front-end can scale horizontally behind a sticky proxy; you'll need to
add Redis (or Postgres `LISTEN/NOTIFY`) to fan-out WS events. Tracked
as a future enhancement, not currently implemented.

## Reading logs

```sh
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f web

# Structured pino logs from the API are JSON; pipe through:
docker compose -f docker-compose.prod.yml logs --no-color api | pino-pretty
```

## Health checks

| URL                                  | Expected                              |
| ------------------------------------ | ------------------------------------- |
| `https://operator.example.com/healthz` | `{"status":"ok","version":"..."}`    |
| `https://operator.example.com/v1/auth/me` (with session cookie) | Your profile + groups |

Both are safe to wire into uptime monitoring.

## Upgrades

```sh
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The API container runs migrations on startup by default; downtime is
sub-second.
