# BUSY Bar monitor

The operator API can drive a dedicated [BUSY Bar](https://busy.app/) through
BUSY Cloud. The front display is the primary at-a-glance booth monitor; the back
display holds close-range diagnostics.

## Behaviour

- While the booth is healthy and idle, the front alternates every eight seconds
  between `READY` and a compact system-health frame.
- Any call activity immediately pins the corresponding state (`CALLING`,
  `PLAYING`, `RECORDING`, or `SENDING`).
- Warning, error, and stale/offline frames remain pinned until recovery.
- The back display has Call, System, and Network pages.
- Encoder movement, OK, and START cycle back pages; BACK returns to Call.
  Switch events and button releases are ignored.
- BUSY inputs never mutate booth state.
- Critical audio runs only on transitions into booth error or stale/offline and
  is rate-limited.

The monitor uses display priority 100 by default. This intentionally overrides
the bar's built-in BUSY/CUSTOM sessions, so use a dedicated device.

## BUSY account setup

1. Link the BUSY Bar to the BUSY account and verify it is reachable in BUSY
   Cloud.
2. Generate an API token at <https://cloud.busy.app/api-tokens>.
3. Confirm the installed firmware accepts remote display draw/clear requests.
4. Identify a valid stock audio path for `BUSY_BAR_ALERT_SOUND`.
5. Confirm the cloud state WebSocket accepts the token, device subscription,
   and emits a physical input event. Official BUSY libraries have used both
   direct-token and ticket-token handshakes; do not enable input navigation
   until this is verified against the deployed account and firmware.

## Configuration

Set these values in the API environment:

```dotenv
BUSY_BAR_MONITOR_ENABLED=true
BUSY_BAR_CLOUD_TOKEN=replace-with-secret-token
BUSY_BAR_API_URL=https://api.busy.app
BUSY_BAR_CLOUD_WS_URL=wss://api.busy.app/api/v1/bars/ws
BUSY_BAR_DEVICE_ID=
BUSY_BAR_APPLICATION_NAME=telephone-booth-monitor
BUSY_BAR_DISPLAY_PRIORITY=100
BUSY_BAR_STALE_AFTER_SECONDS=20
BUSY_BAR_RENDER_DEBOUNCE_MS=250
BUSY_BAR_FRONT_ROTATION_SECONDS=8
BUSY_BAR_AUDIO_ENABLED=true
BUSY_BAR_ALERT_SOUND=replace-with-verified-stock-path
BUSY_BAR_ALERT_COOLDOWN_SECONDS=300
```

`BUSY_BAR_DEVICE_ID` is optional for a single-bar account. The API first asks
BUSY account info is not a reliable device UUID source, so set this variable to
enable physical input navigation. Display and audio output do not require it.

The token and alert sound are required when their corresponding features are
enabled. Invalid enabled configuration prevents API startup; runtime BUSY
outages do not.

## Rollout checklist

Before enabling the monitor in production:

1. Verify `READY` and the health frame at the expected distance and ambient
   light.
2. Exercise every booth state and confirm active states cancel rotation
   immediately.
3. Confirm health warnings and offline state remain pinned until recovery.
4. Cycle all three back pages with encoder/buttons and verify the front does not
   flicker.
5. Restart the API and bar independently and confirm automatic recovery.
6. Disconnect BUSY Cloud and booth telemetry separately and confirm the operator
   API remains healthy.
7. Trigger repeated critical conditions and confirm the audio cooldown.
8. Revoke/rotate the BUSY token and verify authentication failures are visible
   without leaking the token.

## Troubleshooting

- **No display:** verify the token, cloud reachability, linked account, and
  priority. The application namespace is `telephone-booth-monitor` by default.
- **No input navigation:** set `BUSY_BAR_DEVICE_ID` explicitly and verify the
  deployed cloud WebSocket authentication flow.
- **No audio:** verify `BUSY_BAR_ALERT_SOUND` names a stock sound supported by
  the installed firmware.
- **Repeated retries:** inspect structured API logs for BUSY render or
  input-stream failures. The API continues serving normal traffic.

To roll back immediately, set `BUSY_BAR_MONITOR_ENABLED=false` and restart the
API.
