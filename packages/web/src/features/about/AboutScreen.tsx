import { GlassPanel } from "../../components/booth/index.js";

export function AboutScreen(): JSX.Element {
  return (
    <GlassPanel title="About Telephone Booth Operator" className="feature-screen about-screen">
      <div className="about-logo" aria-hidden="true">
        <svg viewBox="0 0 96 84"><path d="M48 2 92 23v38L48 82 4 61V23z" /><text x="48" y="54" textAnchor="middle">B</text></svg>
      </div>
      <p className="screen-kicker">Digit 6</p>
      <h1>About</h1>
      <p>Telephone Booth Operator is a switchboard for a participatory installation: an all-red 1980s Canadian Bell outdoor booth with a Northern Electric Contempra inside.</p>
      <section className="feature-card feature-card--wide">
        <h2>Design philosophy</h2>
        <p>The interface treats the rotary phone as navigation, the glass booth as chrome, and clear operator copy as the main line. It should feel nostalgic without becoming unclear.</p>
      </section>
      <section className="feature-card feature-card--wide">
        <h2>Stack credits</h2>
        <p>React 18, Vite, TanStack Router, TanStack Query, TypeScript, Zod, Vitest, and an Hono API keep the line connected.</p>
      </section>
      <section className="feature-card feature-card--wide">
        <h2>License and source</h2>
        <p>Licensed Apache-2.0. Source lives on <a href="https://github.com/djensenius/Telephone-Booth-Operator">GitHub</a>.</p>
      </section>
    </GlassPanel>
  );
}
