# ADR 0003 — Azure Blob with SAS uploads

**Status:** accepted.

## Context

The legacy installation streamed recording uploads through the Express
app, which then wrote them to disk on the same VM. That coupled storage
durability to the app server's disk and made the app a chokepoint for
multi-MB FLAC uploads.

## Decision

- Recordings live in **Azure Blob Storage** (or Azurite locally).
- The API mints short-lived **SAS URLs**; the phone client uploads
  directly to blob storage.
- The API never sees recording bytes, only metadata.

## Consequences

**Good:**

- Operator API is stateless and cheap.
- Storage is independently durable and backed up by Azure.
- Browsers download with the same short-lived SAS, no proxy in between.

**Trade-offs:**

- One more external service to set up — but Azurite makes local dev
  trivial.
- SAS TTLs must be tuned for slow networks (default 15 min upload, 5
  min read).
- Locks us to Azure unless we abstract storage behind a port. Tracked
  as a future enhancement; today the project owner uses Azure.
