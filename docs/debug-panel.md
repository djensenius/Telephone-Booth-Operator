# Debug panel

The operator Debug panel is rotary digit **9** (`/debug`). It connects to
the phone client's `booth-debug` HTTP and WebSocket surface and displays
live state, GPIO, audio meters, logs, redacted config, and optional
simulation controls.

## Screenshot placeholders

- `[screenshot: debug overview with connection bar]`
- `[screenshot: GPIO and audio panels]`
- `[screenshot: Settings Phone Client Connection panel]`

## Connection setup

1. Open **Settings** (digit **6**) and find **Phone Client Connection**.
2. Paste the Tailscale URL, for example `https://phone-booth.tail-scale.ts.net`.
3. Paste the LAN fallback URL, for example `https://192.168.1.42:8443`.
4. Paste the debug token from the phone client.
5. Click **Test connection**. The UI prefers Tailscale and falls back to
   LAN after repeated 2s failures.
6. Click **Pin LAN cert** while Tailscale is reachable. The operator
   fetches `/v1/cert/fingerprint` over Tailscale and stores the SHA-256
   fingerprint in browser localStorage scoped to the OIDC user subject.
7. On first LAN use, the browser will still warn about the self-signed
   certificate. Compare the browser certificate fingerprint with the
   pinned value, then accept the exception once.

Simulation controls only appear when `/v1/config` reports `debug.allowControls: true`.
