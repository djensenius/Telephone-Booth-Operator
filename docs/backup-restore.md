# Backup & restore (full data export/import)

The operator API can export a **complete** archive of an installation —
the entire Postgres data set (minus ephemeral OIDC sessions) plus **all
audio blobs** — and restore it into another instance. Both operations are
**admin-only** (the caller must belong to the Authentik admin group; see
[`authentik-setup.md`](authentik-setup.md)).

## What's in the archive

A single `.tar` file containing:

| Entry            | Contents                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`  | Format/version, generation time, row counts, blob count, and any `missingBlobs` (files whose audio was absent from storage at export time).                                                     |
| `data.json`      | Every exported table: questions, messages, files, booth events, call sessions, operator users, API tokens, transcriptions, moderations, metric filters, mobile devices, booth status snapshots. |
| `blobs/<sha256>` | One entry per unique audio file, content-addressed by SHA-256.                                                                                                                                  |

Deliberately **excluded**:

- **`OperatorSession`** rows — they hold live id/access/refresh tokens
  (plaintext credentials). Sessions are ephemeral; operators simply log in
  again after a restore.
- **SAS URLs** — never materialised into the archive. Only the stable
  `blobKey`/`sha256` travel, so SAS scope and lifetime rules are untouched.

API-token rows are included so tokens keep working after a restore, but
only their Argon2id **hash** is stored — never a plaintext token.

### Archive versions

`manifest.json` carries a numeric `version`. A server restores its own version
and anything older, and rejects anything newer than it understands.

| Version | Change                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Original shape.                                                                                                                                                                                                        |
| 2       | Booth status snapshots carry `firstSeenAt`/`repeatCount`. Version 1 snapshots restore with their window starting at the report time.                                                                                   |
| 3       | Installations are exported, and scoped rows carry `installationId`. Older archives restore untagged rows into an ended `Restored <generatedAt>` installation so they remain browsable without becoming the active era. |

## Endpoints

```text
GET  /v1/admin/data/export        → application/x-tar download (everything)
GET  /v1/installations/:id/export → application/x-tar download (one era)
POST /v1/admin/data/import        ← raw tar body (application/x-tar)
```

The scoped export contains only the rows belonging to that installation, plus
the blobs they reference — download one before purging an era if you want a
copy to keep. See [installations](installations.md).

Because a per-era archive is meant to be handed around, it deliberately
withholds the instance's credentials and personal data: **API tokens, mobile
devices, and metric filters are omitted entirely**, and operator accounts are
narrowed to the ones the era's own rows point at (who ended it, who moderated a
message, who requested a transcription). Instructions travel whole, because
they are booth configuration and their audio would otherwise dangle. Use the
full `/v1/admin/data/export` when you want a restorable copy of the instance.

Import is **idempotent**: rows are upserted by id, and each audio blob is
uploaded only when the target storage does not already hold it (dedupe by
`blobKey`). Every blob's bytes are re-hashed and checked against the
archived `sha256` before upload, so a corrupted archive is rejected.

Only one installation may be open at a time. If the archive carries an active
era and the target already has one, the target's yields: an era with nothing
recorded against it is removed, and one holding data is closed out so nothing
becomes unreachable. That close-out is the same operation `POST /:id/end`
performs — open sessions are ended, the moderation queue is emptied, live
questions are retired and the summary is frozen — so a restored instance never
inherits an era that is ended in name only while its pending messages keep
feeding the moderation badge.

## CLI wrapper

[`tools/data-backup.ts`](../tools/data-backup.ts) wraps both endpoints.
Provide the API base URL and admin credentials via environment variables:

```sh
# Export
OPERATOR_API_URL=https://operator.example \
OPERATOR_TOKEN=<admin-operator-bearer-token> \
  tsx tools/data-backup.ts export ./backup-$(date +%F).tar

# Restore into a target instance
OPERATOR_API_URL=https://operator.example \
OPERATOR_TOKEN=<admin-operator-bearer-token> \
  tsx tools/data-backup.ts import ./backup-2025-01-01.tar
```

`OPERATOR_COOKIE` (a raw session cookie header value) may be used instead
of `OPERATOR_TOKEN`.

## Restore checklist

1. Point `OPERATOR_API_URL` at the **target** instance.
2. Ensure the target's Azure Blob container exists and is writable.
3. Run `import`. Review the returned summary (`rows`, `blobsUploaded`,
   `blobsSkipped`).
4. Operators log in again (sessions are not restored).
