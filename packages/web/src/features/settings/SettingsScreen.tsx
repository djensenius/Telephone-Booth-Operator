import { useEffect, useState } from "react";
import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";
import { LogoutButton } from "../auth/LogoutButton.js";
import { useCurrentUser } from "../auth/useCurrentUser.js";
import { PhoneClientConnection } from "./PhoneClientConnection.js";

const fontSizeKey = "booth.theme.fontSize";
const highContrastKey = "booth.theme.highContrast";

function readSetting(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preference persistence can be unavailable.
  }
}

export function SettingsScreen(): JSX.Element {
  const { user } = useCurrentUser();
  const { muted, reducedMotionOverride, setMuted, setReducedMotionOverride } = useBoothStatus();
  const [fontSize, setFontSize] = useState(() => readSetting(fontSizeKey, "normal"));
  const [highContrast, setHighContrast] = useState(() => readSetting(highContrastKey, "false") === "true");

  useEffect(() => {
    document.documentElement.dataset.boothFontSize = fontSize;
    writeSetting(fontSizeKey, fontSize);
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.classList.toggle("booth-high-contrast", highContrast);
    writeSetting(highContrastKey, String(highContrast));
  }, [highContrast]);

  return (
    <GlassPanel title="Operator settings" className="feature-screen settings-screen">
      <p className="screen-kicker">Digit 5</p>
      <h1>Settings</h1>
      <p>Set operator preferences and keep the phone-client connection card close at hand.</p>
      <section className="feature-card">
        <h2>Account</h2>
        <dl className="debug-kv-grid debug-kv-grid--compact">
          <div><dt>Operator</dt><dd>{user?.name ?? "Unknown"}</dd></div>
          <div><dt>Email</dt><dd>{user?.email ?? "Unknown"}</dd></div>
          <div><dt>Provider</dt><dd>{user?.providerName ?? "OIDC"}</dd></div>
        </dl>
        <div className="debug-button-row"><LogoutButton /></div>
      </section>
      <section className="feature-card">
        <h2>Theme</h2>
        <div className="settings-list">
          <label>
            Font size
            <select value={fontSize} onChange={(event) => setFontSize(event.currentTarget.value)}>
              <option value="normal">Normal operator card</option>
              <option value="large">Large print</option>
              <option value="extra-large">Extra large print</option>
            </select>
          </label>
          <label><input type="checkbox" checked={muted} onChange={(event) => setMuted(event.currentTarget.checked)} /> Mute booth sounds</label>
          <label><input type="checkbox" checked={reducedMotionOverride} onChange={(event) => setReducedMotionOverride(event.currentTarget.checked)} /> Allow spring motion and sounds when reduced motion is requested</label>
          <label><input type="checkbox" checked={highContrast} onChange={(event) => setHighContrast(event.currentTarget.checked)} /> High contrast glass panels</label>
        </div>
      </section>
      <PhoneClientConnection userSub={user?.id ?? "anonymous"} />
    </GlassPanel>
  );
}
