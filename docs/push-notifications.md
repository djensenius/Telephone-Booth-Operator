# Push notifications (APNs)

The operator sends Apple Push Notification service (APNs) alerts to the
[`Telephone-Booth-Operator-Mobile`](https://github.com/djensenius/Telephone-Booth-Operator-Mobile)
clients (iOS, iPadOS, macOS, watchOS, visionOS, tvOS) when something notable
happens — most importantly when a new message is received and is awaiting
moderation. Separate badge-only pushes carry an `aps.badge` count so the app
icon and the **Messages** tab show the number of messages awaiting moderation.

This document covers how the pipeline works, the environment variables that
turn it on, and how to configure them in production.

## How it works

1. The mobile app requests notification authorization, registers for remote
   notifications, and upserts its APNs device token via `POST /v1/devices`
   (`apnsToken` + `platform`). Tokens are stored in the `mobile_devices` table.
2. When a message hits `POST /v1/messages/{id}/complete`, the API computes the
   current **awaiting-moderation** count (messages with status `received` or
   `pending`) and makes at most one best-effort alert attempt for each
   empty-to-non-empty queue cycle. The alert intentionally omits a numeric
   count and badge; durable badge-only pushes remain the authoritative count.
   The cycle is consumed before fan-out so a partial APNs failure cannot cause
   successful targets to receive duplicate lock-screen alerts on retry.
   Further arrivals update the badge without adding more alerts. The app
   removes the delivered queue alert when the operator opens matching content.
3. Every queue-changing operation records the latest badge count in durable
   delivery state. A database lease serializes badge-only pushes across API
   replicas, coalesces changes that arrive during an in-flight send, and lets a
   restarted process recover pending work. The worker also recounts the queue
   periodically so a change missed between a request commit and its observer is
   recovered without creating duplicate versions for unchanged counts.
   Transient APNs failures leave the newest version pending for retry. These
   pushes carry no banner or sound and go to every registered device even when
   new-message alerts are disabled. Decisions, deletions, installation
   rollovers, data restores, and device registrations therefore lower, reset,
   or refresh the icon badge while the app is backgrounded or closed.
4. A newly recorded moderation result with `flagged: true` sends a
   `messageFlagged` alert. Re-delivery of the same moderation row is deduplicated.
5. `moderationQueueHigh` fires once when the awaiting-moderation count crosses
   `MODERATION_QUEUE_HIGH_THRESHOLD` (default `10`). It is re-armed whenever a
   decision, deletion, installation close-out, data restore, or other queue
   transition brings the count below the threshold.
6. Alert and badge-only notifications use `apns-push-type: alert` and
   `apns-priority: 10`; badge-only payloads contain just `aps.badge`. The OS
   updates the app icon without launching the app or showing an alert. The app
   also refreshes its in-app tab badge on foreground and on push receipt.
7. The same count is exposed at `GET /v1/stats/summary`
   (`messages.awaitingModeration`) so the app can poll and stay in sync even
   when a push is missed.

The transport lives in `packages/api/src/lib/apns-http2.ts` (an HTTP/2,
ES256-signed sender). The awaiting-moderation count is centralized in
`packages/api/src/lib/moderation-badge.ts`.

## Environment variables

Push is **off** unless all four required variables are present
(`isApnsDeliveryConfigured()` gates the fan-out and badge dispatcher). Without
them the API falls back to a no-op sender, so dev and CI never emit pushes.
Pending badge state is retained and delivered after APNs is configured.

| Variable                          | Required | Description                                                            |
| --------------------------------- | -------- | ---------------------------------------------------------------------- |
| `APNS_TEAM_ID`                    | yes      | 10-char Apple Developer Team ID.                                       |
| `APNS_KEY_ID`                     | yes      | 10-char Key ID of the APNs Auth Key (`.p8`).                           |
| `APNS_AUTH_KEY`                   | yes      | PEM contents of the `.p8`. Literal `\n` escapes are accepted.          |
| `APNS_BUNDLE_ID`                  | yes      | App bundle id. The watch topic is derived as `<APNS_BUNDLE_ID>.watch`. |
| `APNS_ENVIRONMENT`                | no       | `production` or `development`; defaults to sandbox (`development`).    |
| `MODERATION_QUEUE_HIGH_THRESHOLD` | no       | Queue count that triggers the opt-in high-queue alert (default `10`).  |

### About the APNs Auth Key

An APNs Auth Key (token-based, `.p8`) is **account/team-wide** — one key can
sign pushes for every app under the same Apple Developer Team. Create one at
<https://developer.apple.com> → **Certificates, Identifiers & Profiles** →
**Keys** → **Add**, enable **Apple Push Notifications service (APNs)**, and
download the `.p8` once (it cannot be re-downloaded). The Key ID is shown next
to the key (and is part of the downloaded filename, `AuthKey_<KEYID>.p8`).

> **Never commit the `.p8` or its contents.** Store it only in your secret
> manager (e.g. an Azure Container App secret).

### Sandbox vs production — the #1 gotcha

The APNs **host must match the environment that minted the device token**:

- Xcode/debug builds installed directly on a device get **sandbox** tokens →
  set `APNS_ENVIRONMENT=development` (sandbox host).
- TestFlight and App Store builds get **production** tokens → set
  `APNS_ENVIRONMENT=production`.

A mismatch shows up as `BadDeviceToken` from APNs. The auth key itself works
against both hosts; only the host (environment) is the discriminator.

## Configuring production (Azure Container Apps)

The deployed API runs as the `telephone-booth-api` Container App. Store the key
as a secret and reference it from the env var; set the rest as plain env vars.

```sh
# 1. Store the .p8 as a secret (never commit the key).
az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --secrets apns-auth-key="$(cat /path/to/AuthKey_XXXXXXXXXX.p8)"

# 2. Point the env vars at it (this creates a new revision).
az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --set-env-vars \
    APNS_TEAM_ID=XXXXXXXXXX \
    APNS_KEY_ID=XXXXXXXXXX \
    APNS_BUNDLE_ID=org.davidjensenius.TelephoneBoothOperatorMobile \
    APNS_ENVIRONMENT=production \
    APNS_AUTH_KEY=secretref:apns-auth-key
```

Verify the new revision is healthy and the variables are present (the auth key
should appear only as a `secretRef`, never as a value):

```sh
az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --query "properties.template.containers[0].env[?starts_with(name,'APNS')].{name:name,value:value,secretRef:secretRef}" \
  --output table
```

## Token revocation

When APNs reports that a token is permanently invalid — `Unregistered`,
`BadDeviceToken`, `DeviceTokenNotForTopic`, or `ExpiredToken` — the sender
revokes the corresponding `mobile_devices` row so the API stops pushing to it.
The device re-registers the next time the app launches and calls
`POST /v1/devices`.

## Troubleshooting

- **No pushes at all** — confirm all four required vars are set
  (`isApnsDeliveryConfigured()` must be true) and that at least one device row
  exists in `mobile_devices`.
- **Configuration state** — `GET /healthz` reports `apns.status` as
  `configured`, `disabled`, or `misconfigured`, plus missing/invalid variable
  names only. Startup and delivery failures are logged as structured Pino
  events without device tokens or notification payloads.
- **`BadDeviceToken`** — `APNS_ENVIRONMENT` does not match how the app was
  installed (sandbox vs production). See the gotcha above.
- **`DeviceTokenNotForTopic`** — `APNS_BUNDLE_ID` does not match the app's
  bundle id (or the watch topic `<bundle>.watch`).
- **Badge shows 0 right after a message arrives** — the badge counts messages
  awaiting moderation (`received` + `pending`); a just-received message is
  included immediately, so this should not happen with a current build.

See also [Azure deployment](azure-deployment.md) and
[Mobile clients](mobile-clients.md).
