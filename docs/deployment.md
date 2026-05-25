# Deployment

The operator stack is two container images: an API and a static-served
React UI. Both are built from this repo and published to GitHub Container
Registry on `workflow_dispatch`:

- `ghcr.io/djensenius/telephone-booth-operator-api`
- `ghcr.io/djensenius/telephone-booth-operator-web`

## Building images locally

```sh
just docker-build
docker images | grep telephone-booth
```

## Required external services

| Service                      | What for                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| **Postgres ≥ 15**            | Operator data                                                   |
| **Azure Blob Storage**       | Recordings (see [`azure-storage.md`](azure-storage.md))         |
| **An OIDC provider**         | Operator login (see [`authentik-setup.md`](authentik-setup.md)) |
| **A reverse proxy with TLS** | Caddy / nginx / Traefik in front                                |

Postgres and Blob can both run in-cluster or as managed services. The
reverse proxy is **required** because the operator UI sets `Secure`
session cookies that browsers reject over plain HTTP.

## Minimal production `docker-compose`

`docker-compose.prod.yml` (already in this repo) deploys both containers; you
supply `.env` and either a managed Postgres or the opt-in single-node `db`
service:

```sh
cp .env.example .env             # populate AUTHENTIK_* + SESSION_SECRET + AZURE_*
docker compose -f docker-compose.prod.yml up -d
# or, for single-node with bundled postgres:
docker compose -f docker-compose.prod.yml --profile single-node up -d
```

When you use the bundled single-node Postgres service, you **must** set
`POSTGRES_PASSWORD` in `.env` — Compose will refuse to start without it.
Generate one with `openssl rand -base64 24`. Then set `DATABASE_URL` to match,
for example
`postgres://booth:${POSTGRES_PASSWORD}@db:5432/telephone_booth`. For managed
Postgres, set `DATABASE_URL` to the external provider's TLS connection string.

Place a reverse proxy in front:

- **API** on internal `:8787`, proxied at `https://operator.example.com/v1/*`
  and `https://operator.example.com/healthz` and the WS upgrade at
  `https://operator.example.com/v1/ws/*`.
- **Web** on internal `:80`, proxied at `https://operator.example.com/`.

### Caddy example

```Caddyfile
operator.example.com {
    encode zstd gzip
    @api path /v1/* /healthz
    handle @api {
        reverse_proxy api:8787
    }
    handle {
        reverse_proxy web:80
    }
}
```

Caddy auto-issues + rotates TLS via Let's Encrypt on first hit.

### nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name operator.example.com;

    ssl_certificate     /etc/letsencrypt/live/operator.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/operator.example.com/privkey.pem;

    location /v1/ws/ {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_pass http://api:8787;
    }

    location ~ ^/(v1|healthz)/ {
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_pass http://api:8787;
    }

    location / {
        proxy_set_header Host $host;
        proxy_pass http://web:80;
    }
}
```

## Database migrations on deploy

The API container does not run Prisma migrations automatically. Run migrations
as an explicit deploy step before serving a new release:

```sh
docker compose -f docker-compose.prod.yml run --rm api \
  pnpm exec prisma migrate deploy
```

For Azure Container Apps, run the same command from a one-off job. See
[`azure-deployment.md`](azure-deployment.md).

## Secrets management

- `SESSION_SECRET`: rotate annually; rotating logs everyone out (see
  [`runbook.md`](runbook.md)).
- `AUTHENTIK_CLIENT_SECRET`: rotate quarterly or after personnel
  changes; sessions survive rotation.
- `AZURE_STORAGE_CONNECTION_STRING`: rotate the storage account key when staff
  access changes. Managed Identity SAS issuing is not implemented yet. See
  [`azure-storage.md`](azure-storage.md).
- Phone-client API tokens: rotated via the operator UI; old ones can be
  revoked instantly.

Use whichever secrets store your platform offers (Vault, 1Password, Doppler,
AKV, …). Plain `.env` files are fine for solo / home deployments.

## Observability

The API ships structured pino logs to stdout (`LOG_LEVEL=info`); pipe
them into whatever log shipper you use. There's no built-in tracing
exporter yet — that's tracked in `docs/adr/` for a future ADR.
