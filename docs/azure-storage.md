# Azure Blob Storage

The operator backend stores every recording in Azure Blob Storage as
content-addressed audio. Booth recordings are FLAC; operator-uploaded question
and instruction audio may also be WAV, AIFF, MP3, M4A, or Ogg. Locally we use the
[Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite)
emulator so dev needs no Azure subscription.

## Container layout

```text
booth-recordings/                          # container
├── messages/
│   └── <sha256-prefix>/<sha256>.flac      # uploaded messages
├── questions/
│   └── <sha256-prefix>/<sha256>.<ext>     # operator-recorded questions
├── instructions/
│   └── <sha256-prefix>/<sha256>.<ext>     # admin-uploaded instruction prompt (digit 0)
└── system/
    ├── beep.flac                          # built into the Rust client too
    └── dial-tone.flac                     # built into the Rust client too
```

`<sha256-prefix>` is the first 2 hex chars of the file's sha256, used as
a directory level to keep individual prefix listings small.

Container name is configurable: `AZURE_BLOB_CONTAINER` (default
`booth-recordings`).

## SAS scoping

The API never proxies file bytes. Every upload and every download uses a
**short-lived SAS URL** scoped to a single blob:

- **Upload SAS:** `cw` (create + write), 15 min TTL, scoped to one blob
  key, with its audio content type pinned. Issued by `POST /v1/messages`
  for message recordings or `POST /v1/uploads/sas` for explicit upload
  slots.
- **Download SAS:** `r` (read), 5 min TTL, scoped to one blob key.
  Issued whenever the API serializes an `AudioRef` for the browser or
  the phone client.

TTLs are tunable via `AZURE_SAS_TTL_MINUTES` and `AZURE_SAS_READ_TTL_MINUTES`.

## Local dev (Azurite)

`docker-compose.yml` brings up Azurite at `localhost:10000`:

```yaml
azurite:
  image: mcr.microsoft.com/azure-storage/azurite:latest
  command: azurite-blob --blobHost 0.0.0.0 --blobPort 10000 …
```

`.env.example` ships with Azurite's well-known dev connection string. The
SDK works identically against Azurite and a real account; switching is a
one-line change in `.env`.

## Production setup

1. **Create a Storage account.** General-purpose v2; LRS replication is
   plenty for an art installation. Pick a region close to your operators.
2. **Create the container.** `booth-recordings`, private access (no public
   read).
3. **Create an access key.** The current API creates per-blob SAS URLs from an
   account-key connection string. Managed Identity / RBAC-only SAS issuing is
   not implemented yet.
4. **Set `.env`:**

   ```ini
   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
   AZURE_BLOB_CONTAINER=booth-recordings
   ```

Store the connection string in your platform's secret manager, not in source
control. Rotate the storage account key when staff access changes.

## CORS (required for browser uploads)

The API never proxies file bytes — the browser `PUT`s recordings **directly**
to the SAS URL. Because the Blob endpoint is a different origin from the web
app, that `PUT` is cross-origin; the `PUT` method and the `x-ms-blob-type` /
`Content-Type` headers make it non-simple, so the browser first fires a
preflight `OPTIONS`. If the storage account has **no matching CORS rule**,
Azure rejects the preflight with **HTTP 403** and the upload fails before any
bytes are sent:

```text
Preflight response is not successful. Status code: 403
Fetch API cannot load https://<account>.blob.core.windows.net/booth-recordings/...flac
```

Azurite also starts without a matching CORS rule. The local compose service
does not initialize one, so browser uploads from another local port can hit the
same preflight failure until Blob-service CORS is configured.

> **CORS is not an authorization control.** It is a browser-enforced policy
> about which _web origins_ may make cross-origin requests; non-browser
> clients (e.g. the Rust phone client, `curl`) ignore it entirely. Adding a
> CORS rule does **not** widen who can upload — that gate is the SAS itself:
> callers must authenticate to obtain one (`POST /v1/messages` /
> `POST /v1/uploads/sas`), and each SAS is `cw`-only, pinned to a single
> content-addressed blob key, with a short TTL. The API tells clients to upload
> `audio/flac` and stores the resulting blob content type, but the SAS token is
> not a media-type authorization boundary. This is why we keep direct-to-blob
> uploads (see
> [ADR 0003](./adr/0003-azure-blob-with-sas-uploads.md)) rather than proxying
> bytes through the API.

Configure Blob-service CORS once, scoped to the operator web origin(s) — the
same value(s) as `WEB_ORIGIN`. **Do not use `*`;** list exact origins:

```sh
az storage cors add \
  --services b \
  --account-name <account> \
  --account-key "<key>" \
  --origins "https://operator.example.com" "https://web.example.com" \
  --methods GET HEAD PUT OPTIONS \
  --allowed-headers "*" \
  --exposed-headers "*" \
  --max-age 3600
```

For the local Azurite compose service, target the emulator endpoint with its
connection string instead of an Azure account name/key:

```sh
az storage cors add \
  --services b \
  --connection-string "$AZURE_STORAGE_CONNECTION_STRING" \
  --origins "http://localhost:5173" \
  --methods GET HEAD PUT OPTIONS \
  --allowed-headers "*" \
  --exposed-headers "*" \
  --max-age 3600
```

The rule takes effect within a minute and needs no redeploy. Verify with a
preflight (CORS is evaluated before auth, so no valid SAS is required):

```sh
az storage cors list --services b --account-name <account> --account-key "<key>"

curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  "https://<account>.blob.core.windows.net/booth-recordings/probe.flac" \
  -H "Origin: https://operator.example.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: x-ms-blob-type,content-type"
# expect: 200
```

## Lifecycle / retention

Recordings stay around indefinitely by default. To prune, add a
container-level lifecycle policy in the Azure portal:

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "messages-cool-after-30d",
      "type": "Lifecycle",
      "definition": {
        "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["messages/"] },
        "actions": {
          "baseBlob": {
            "tierToCool": { "daysAfterModificationGreaterThan": 30 },
            "tierToArchive": { "daysAfterModificationGreaterThan": 180 },
            "delete": { "daysAfterModificationGreaterThan": 730 }
          }
        }
      }
    }
  ]
}
```

That moves messages to Cool after a month, Archive after six, and deletes
after two years. Tune to your installation's longevity.

## Cost estimate

For a booth that collects ~20 recordings per day, averaging 30 s @ 48 kHz
mono FLAC (~2.5 MB each):

- **Storage:** ~1.5 GB / year. ≪ $1 / month on Hot LRS.
- **Egress:** trivial, since the operator pulls each file at most a few
  times.
- **Operations:** ~40 writes + ~100 reads per day. < $0.05 / month.

Realistic monthly bill: **under $1** for a single booth. Long-tail
storage from old installations dominates only after years.
