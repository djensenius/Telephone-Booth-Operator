import { useState } from "react";
import { createDebugClient, emptyDebugConnectionPrefs, forgetDebugConnectionPrefs, readDebugConnectionPrefs, writeDebugConnectionPrefs } from "../../lib/debug-client.js";
import type { DebugConnectionPrefs } from "../../lib/debug-client.js";

export interface PhoneClientConnectionProps {
  readonly userSub?: string;
}

function withTimestamp(prefs: Omit<DebugConnectionPrefs, "updatedAt">): DebugConnectionPrefs {
  return { ...prefs, updatedAt: new Date().toISOString() };
}

export function PhoneClientConnection({ userSub = "anonymous" }: PhoneClientConnectionProps): JSX.Element {
  const [prefs, setPrefs] = useState(() => readDebugConnectionPrefs(userSub));
  const [status, setStatus] = useState("Connection settings are stored in this browser.");
  const [busy, setBusy] = useState(false);

  function updateField(field: keyof Omit<DebugConnectionPrefs, "updatedAt">, value: string): void {
    const next = withTimestamp({ ...prefs, [field]: value });
    setPrefs(next);
    writeDebugConnectionPrefs(next, userSub);
  }

  async function testConnection(): Promise<void> {
    setBusy(true);
    setStatus("Dialing the phone client…");
    try {
      const client = createDebugClient({ tailscaleUrl: prefs.tailscaleUrl, lanUrl: prefs.lanUrl, token: prefs.token, pinnedFingerprint: prefs.pinnedFingerprint });
      const health = await client.getHealth();
      setStatus(`Connected. Debug surface version ${health.version}.`);
    } catch (error) {
      setStatus(error instanceof Error ? `Connection failed: ${error.message}` : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function pinLanCert(): Promise<void> {
    setBusy(true);
    setStatus("Fetching LAN certificate fingerprint over the trusted Tailscale line…");
    try {
      const client = createDebugClient({ tailscaleUrl: prefs.tailscaleUrl, lanUrl: prefs.lanUrl, token: prefs.token });
      const fingerprint = await client.getLanCertificateFingerprint();
      const next = withTimestamp({ ...prefs, pinnedFingerprint: fingerprint });
      setPrefs(next);
      writeDebugConnectionPrefs(next, userSub);
      setStatus("LAN fingerprint pinned. Compare it with the browser certificate details when accepting the one-time LAN exception.");
    } catch (error) {
      setStatus(error instanceof Error ? `Could not pin fingerprint: ${error.message}` : "Could not pin fingerprint.");
    } finally {
      setBusy(false);
    }
  }

  function forget(): void {
    forgetDebugConnectionPrefs(userSub);
    setPrefs(emptyDebugConnectionPrefs());
    setStatus("Phone client connection settings forgotten.");
  }

  return (
    <section className="settings-connection" aria-labelledby="phone-client-connection-heading">
      <h2 id="phone-client-connection-heading">Phone Client Connection</h2>
      <p>Use Tailscale first. LAN fallback uses a self-signed certificate; pin its SHA-256 fingerprint here, then verify it in your browser certificate details before accepting the one-time exception.</p>
      <div className="settings-connection__fields">
        <label>
          Tailscale URL
          <input type="url" value={prefs.tailscaleUrl} onChange={(event) => updateField("tailscaleUrl", event.currentTarget.value)} placeholder="https://phone-booth.tail-scale.ts.net" />
        </label>
        <label>
          LAN URL
          <input type="url" value={prefs.lanUrl} onChange={(event) => updateField("lanUrl", event.currentTarget.value)} placeholder="https://192.168.1.42:8443" />
        </label>
        <label>
          Debug token
          <input type="password" value={prefs.token} onChange={(event) => updateField("token", event.currentTarget.value)} autoComplete="off" />
        </label>
        <label>
          Pinned LAN fingerprint
          <input value={prefs.pinnedFingerprint} onChange={(event) => updateField("pinnedFingerprint", event.currentTarget.value)} placeholder="sha256 fingerprint" />
        </label>
      </div>
      <div className="debug-button-row">
        <button type="button" onClick={() => void testConnection()} disabled={busy}>Test connection</button>
        <button type="button" onClick={() => void pinLanCert()} disabled={busy || prefs.tailscaleUrl.length === 0}>Pin LAN cert</button>
        <button type="button" onClick={forget} disabled={busy}>Forget</button>
      </div>
      <p aria-live="polite">{status}</p>
    </section>
  );
}
