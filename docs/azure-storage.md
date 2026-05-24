# Azure Blob Storage

The operator backend stores every recording in Azure Blob Storage as
content-addressed FLACs. Locally we use the
[Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite)
emulator so dev needs no Azure subscription.

## Container layout

```text
booth-recordings/                          # container
├── messages/
│   └── <sha256-prefix>/<sha256>.flac      # uploaded messages
├── questions/
│   └── <sha256-prefix>/<sha256>.flac      # operator-recorded questions
└── system/
    ├── beep.flac                          # built into the Rust client too
    ├── dial-tone.flac                     # built into the Rust client too
    └── instructions/<sha256>.flac         # operator-recorded prompt
```

`<sha256-prefix>` is the first 2 hex chars of the file's sha256, used as
a directory level to keep individual prefix listings small.

Container name is configurable: `AZURE_BLOB_CONTAINER` (default
`booth-recordings`).

## SAS scoping

The API never proxies file bytes. Every upload and every download uses a
**short-lived SAS URL** scoped to a single blob:

- **Upload SAS:** `cw` (create + write), 15 min TTL, scoped to one blob
  key, `audio/flac` content type pinned. Issued by `POST /v1/messages`
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

## Lifecycle / retention

Recordings stay around indefinitely by default. To prune, add a
container-level lifecycle policy in the Azure portal:

```json
{
  "rules": [
    { "enabled": true,
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
