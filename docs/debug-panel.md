# Debug panel

The operator Debug panel is digit shortcut **9** (`/debug`), available to
**admin operators only**. It connects to the phone client's `booth-debug`
HTTP and WebSocket surface and displays live state, GPIO, audio meters,
logs, redacted config, and optional simulation controls.

## Screenshot placeholders

- `[screenshot: debug overview with connection bar]`
- `[screenshot: GPIO and audio panels]`
- `[screenshot: Settings Phone Client Connection panel]`

## Connection setup

1. Open **Settings** (digit **6**) and find **Phone Client Connection**.
2. Paste the Tailscale URL, for example `https://phone-booth.tail-scale.ts.net`.
3. Paste the LAN fallback URL, for example `https://192.168.1.42:8443`.
4. Paste the debug token from the phone client. The token is held in memory
   for the current browser session only — it is never written to
   `localStorage`, and must be re-entered after a reload or sign-out. Tokens
   persisted by older builds are stripped from `localStorage` on next load.
5. Click **Test connection**. The UI prefers Tailscale and falls back to
   LAN after repeated 2s failures.
6. Click **Pin LAN cert** while Tailscale is reachable. The operator
   fetches `/v1/cert/fingerprint` over Tailscale and stores the SHA-256
   fingerprint in browser localStorage scoped to the OIDC user subject.
   (Only the URLs and this fingerprint are persisted; the token is not.)
7. On first LAN use, the browser will still warn about the self-signed
   certificate. Compare the browser certificate fingerprint with the
   pinned value, then accept the exception once.

Simulation controls only appear when `/v1/config` reports `debug.allowControls: true`.

## Audio meters

The **Handset meters** panel plots input and output RMS with a held peak
marker. The booth pushes `audio_level` telemetry at roughly 20 Hz over the
WebSocket; when the socket is closed the operator falls back to polling
`GET /v1/audio` every 2s.

Sample age is tracked locally rather than trusting the booth's own timestamps,
so clock skew cannot make a stale reading look fresh. A channel is marked
stale after 500ms without a live sample, or 3s in polled mode. A stale meter
renders as a dimmed hatched bar with a "no recent samples" note — deliberately
not as an empty bar, so a dropped connection is never mistaken for a silent
booth.

The polled snapshot carries both channels and one shared timestamp, so a
channel is only treated as a new sample when its own level and peak change.
Otherwise an active output would keep a stopped input looking fresh.

Peaks are held for 1s and then decay at 12 dB/s. The ballistics are a client
concern and live in `packages/web/src/features/debug/audio-meters.ts`; the
booth reports raw levels only.
