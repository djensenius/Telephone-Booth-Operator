# Azure deployment

This guide deploys the full Telephone-Booth-Operator stack to Azure:

- Azure Database for PostgreSQL Flexible Server for Prisma data.
- Azure Blob Storage for recordings.
- Azure Container Apps for the API and web containers.
- Authentik as the OIDC provider for operator and mobile login.

It assumes the images are published to GHCR:

- `ghcr.io/djensenius/telephone-booth-operator-api:latest`
- `ghcr.io/djensenius/telephone-booth-operator-web:latest`

Use a real tag or digest for production rollouts instead of `latest`.

## 1. Choose names

Use one resource group and one region for the app tier and data services:

```sh
export LOCATION=canadacentral
export RESOURCE_GROUP=rg-telephone-booth-operator
export ENVIRONMENT=cae-telephone-booth
export API_APP=telephone-booth-operator-api
export WEB_APP=telephone-booth-operator-web
export POSTGRES_SERVER=pg-telephone-booth-operator
export POSTGRES_DB=telephone_booth
export STORAGE_ACCOUNT=<globally-unique-storage-name>
export STORAGE_CONTAINER=booth-recordings
```

Storage account names must be globally unique, lowercase, 3-24 characters, and
letters/numbers only.

## 2. Create the resource group

```sh
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION"
```

## 3. Create PostgreSQL

Create a Flexible Server, database, and firewall rule. Use a generated password
from a password manager or `openssl rand -base64 32`.

```sh
export POSTGRES_ADMIN=boothadmin
export POSTGRES_PASSWORD=<strong-password>

az postgres flexible-server create \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --name "$POSTGRES_SERVER" \
  --admin-user "$POSTGRES_ADMIN" \
  --admin-password "$POSTGRES_PASSWORD" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 17 \
  --public-access 0.0.0.0

az postgres flexible-server db create \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$POSTGRES_SERVER" \
  --database-name "$POSTGRES_DB"
```

`--public-access 0.0.0.0` allows Azure-hosted services to connect. For a tighter
deployment, use private networking and Container Apps VNet integration.

Build the application connection string:

```sh
export DATABASE_URL="postgresql://${POSTGRES_ADMIN}:${POSTGRES_PASSWORD}@${POSTGRES_SERVER}.postgres.database.azure.com:5432/${POSTGRES_DB}?sslmode=require"
```

## 4. Create Blob Storage

The current API issues SAS URLs from an account-key connection string. Managed
Identity / RBAC-only SAS issuing is not implemented yet, so keep the key in
Container Apps secrets and rotate it operationally.

```sh
az storage account create \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --name "$STORAGE_ACCOUNT" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

export AZURE_STORAGE_CONNECTION_STRING="$(
  az storage account show-connection-string \
    --resource-group "$RESOURCE_GROUP" \
    --name "$STORAGE_ACCOUNT" \
    --query connectionString \
    --output tsv
)"

az storage container create \
  --name "$STORAGE_CONTAINER" \
  --connection-string "$AZURE_STORAGE_CONNECTION_STRING" \
  --public-access off
```

Optional but recommended: add a lifecycle policy to move old `messages/` blobs
to cool/archive tiers or delete them after your retention period. See
[`azure-storage.md`](azure-storage.md).

## 5. Create the Container Apps environment

```sh
az containerapp env create \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --name "$ENVIRONMENT"
```

If GHCR images are private, create a GitHub personal access token or GitHub App
token with package read access, then configure registry credentials on each app.
Public images do not need registry credentials.

## 6. Prepare application secrets

Generate session keys:

```sh
export SESSION_SECRET="$(openssl rand -hex 32)"
export SESSION_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

Collect Authentik values:

| Variable | Value |
| --- | --- |
| `AUTHENTIK_ISSUER` | Authentik provider issuer, ending in `/application/o/<slug>/` |
| `AUTHENTIK_CLIENT_ID` | Operator web provider client ID |
| `AUTHENTIK_CLIENT_SECRET` | Operator web provider client secret |
| `AUTHENTIK_ALLOWED_GROUPS` | Comma-separated group names allowed into the operator UI |
| `OIDC_MOBILE_AUDIENCES` | Mobile/native Authentik client IDs, for example `telephone-booth-operator-mobile` |

For a single public hostname, use these URLs:

```sh
export PUBLIC_HOSTNAME=operator.example.com
export PUBLIC_WEB_URL="https://${PUBLIC_HOSTNAME}"
export PUBLIC_API_URL="https://${PUBLIC_HOSTNAME}"
export AUTHENTIK_REDIRECT_URI="${PUBLIC_API_URL}/v1/auth/callback"
export AUTHENTIK_POST_LOGOUT_REDIRECT_URI="$PUBLIC_WEB_URL"
export WEB_ORIGIN="$PUBLIC_WEB_URL"
```

In Authentik, add `${AUTHENTIK_REDIRECT_URI}` to the operator provider redirect
URIs and `${AUTHENTIK_POST_LOGOUT_REDIRECT_URI}` to post-logout redirects. The
provider must put a `groups` array claim in the access token. See
[`authentik-setup.md`](authentik-setup.md) and
[`mobile-clients.md`](mobile-clients.md).

## 7. Deploy the API container

The API should receive secrets through Container Apps secrets, not literal
environment values in source control.

```sh
az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENVIRONMENT" \
  --name "$API_APP" \
  --image ghcr.io/djensenius/telephone-booth-operator-api:latest \
  --target-port 8787 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --secrets \
    database-url="$DATABASE_URL" \
    azure-storage-connection-string="$AZURE_STORAGE_CONNECTION_STRING" \
    session-secret="$SESSION_SECRET" \
    session-encryption-key="$SESSION_ENCRYPTION_KEY" \
    authentik-client-secret="$AUTHENTIK_CLIENT_SECRET" \
  --env-vars \
    API_PORT=8787 \
    NODE_ENV=production \
    LOG_LEVEL=info \
    PUBLIC_API_URL="$PUBLIC_API_URL" \
    PUBLIC_WEB_URL="$PUBLIC_WEB_URL" \
    WEB_ORIGIN="$WEB_ORIGIN" \
    TRUSTED_PROXIES=azure-container-apps \
    DATABASE_URL=secretref:database-url \
    AZURE_STORAGE_CONNECTION_STRING=secretref:azure-storage-connection-string \
    AZURE_BLOB_CONTAINER="$STORAGE_CONTAINER" \
    SESSION_SECRET=secretref:session-secret \
    SESSION_ENCRYPTION_KEY=secretref:session-encryption-key \
    AUTHENTIK_ISSUER="$AUTHENTIK_ISSUER" \
    AUTHENTIK_CLIENT_ID="$AUTHENTIK_CLIENT_ID" \
    AUTHENTIK_CLIENT_SECRET=secretref:authentik-client-secret \
    AUTHENTIK_REDIRECT_URI="$AUTHENTIK_REDIRECT_URI" \
    AUTHENTIK_POST_LOGOUT_REDIRECT_URI="$AUTHENTIK_POST_LOGOUT_REDIRECT_URI" \
    AUTHENTIK_ALLOWED_GROUPS="$AUTHENTIK_ALLOWED_GROUPS" \
    OIDC_SCOPES="openid email profile offline_access" \
    OIDC_MOBILE_AUDIENCES="$OIDC_MOBILE_AUDIENCES" \
    AUTH_DISABLED=false
```

Container Apps assigns a default hostname. Capture it if you are not using a
custom domain yet:

```sh
az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --query properties.configuration.ingress.fqdn \
  --output tsv
```

If you use separate API and web hostnames, set `PUBLIC_API_URL`,
`AUTHENTIK_REDIRECT_URI`, and `WEB_ORIGIN` to the final browser-visible values.

## 8. Run database migrations

The API container does not run Prisma migrations automatically. Run migrations
as a one-off job before sending traffic to a new release:

```sh
az containerapp job create \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENVIRONMENT" \
  --name telephone-booth-operator-migrate \
  --trigger-type Manual \
  --replica-timeout 1800 \
  --replica-retry-limit 1 \
  --image ghcr.io/djensenius/telephone-booth-operator-api:latest \
  --secrets database-url="$DATABASE_URL" \
  --env-vars DATABASE_URL=secretref:database-url \
  --command pnpm \
  --args exec prisma migrate deploy

az containerapp job start \
  --resource-group "$RESOURCE_GROUP" \
  --name telephone-booth-operator-migrate
```

Check the job logs before rolling forward:

```sh
az containerapp job execution list \
  --resource-group "$RESOURCE_GROUP" \
  --name telephone-booth-operator-migrate \
  --output table
```

You can reuse the same job for later releases by updating its image tag and
starting it again.

## 9. Deploy the web container

If the web UI and API share the same origin, the browser client can use relative
API URLs and no `VITE_API_BASE_URL` build-time value is required. If they are on
different origins, rebuild the web image with `VITE_API_BASE_URL` set to the API
origin.

```sh
az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENVIRONMENT" \
  --name "$WEB_APP" \
  --image ghcr.io/djensenius/telephone-booth-operator-web:latest \
  --target-port 80 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3
```

For the simplest production layout, put both apps behind one hostname using
Azure Front Door, Application Gateway, or another reverse proxy:

| Path | Backend |
| --- | --- |
| `/v1/*` | API Container App |
| `/v1/ws/*` | API Container App with WebSocket support |
| `/healthz` | API Container App |
| `/*` | Web Container App |

The shared-hostname layout avoids cross-site cookie issues and keeps
`SameSite=Lax` session cookies straightforward.

## 10. Configure DNS and TLS

For Container Apps custom domains:

1. Add the custom domain to the Container App ingress settings.
2. Create the required DNS validation record.
3. Bind a managed certificate or upload your own certificate.

If you put Front Door or Application Gateway in front, terminate TLS there and
forward the original host and scheme headers. WebSocket upgrades must be allowed
for `/v1/ws/status`.

## 11. Smoke test the deployment

```sh
curl -fsS "${PUBLIC_API_URL}/healthz"
```

Then verify:

1. Open `${PUBLIC_WEB_URL}` and complete Authentik login.
2. Confirm the session cookie is `__Host-`, `HttpOnly`, `SameSite=Lax`, and
   `Secure`.
3. Create or rotate a phone-client API token from the operator UI.
4. Upload or approve a short test recording and confirm it appears in the
   private Blob container.
5. Confirm `/v1/ws/status` stays connected from the browser.

## 12. Release and rollback

For each release:

1. Deploy a pinned API image tag.
2. Run `prisma migrate deploy` with the matching API image.
3. Deploy the matching web image tag.
4. Smoke test Authentik login, `/healthz`, Blob upload/download, and WebSocket
   status.

To roll back application code, point the API and web Container Apps back to the
previous image tags. Prisma migrations are forward-only; if a release includes a
schema migration, prepare the rollback plan before applying it.

## Operational notes

- Rotate `SESSION_SECRET` only when you are comfortable logging everyone out.
- Rotate `SESSION_ENCRYPTION_KEY` carefully because it protects stored refresh
  tokens.
- Rotate the Azure Storage account key and update the Container App secret when
  staff access changes.
- Keep `AUTH_DISABLED=false` in every production environment.
- Use `AUTHENTIK_ALLOWED_GROUPS` / `OIDC_ALLOWED_GROUPS` for authorization; the
  Authentik `groups` claim only reports membership.
