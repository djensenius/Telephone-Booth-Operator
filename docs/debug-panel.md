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
   `localStorage`, and must be re-entered after a reload or sign-out.
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
