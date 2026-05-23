import { GlassPanel } from "../../components/booth/index.js";

export function AboutScreen(): JSX.Element {
  return (
    <GlassPanel title="About Telephone Booth Operator">
      <p className="screen-kicker">Digit 0</p>
      <h1>About</h1>
      <p>Bell Canada booth-inspired operator console for the Telephone Booth installation.</p>
      <p>Typography and sound placeholders are documented with local assets in this package.</p>
    </GlassPanel>
  );
}
