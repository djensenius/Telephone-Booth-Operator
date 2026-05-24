import { GlassPanel } from "../../components/booth/index.js";

export function AboutScreen(): JSX.Element {
  return (
    <GlassPanel title="About Telephone Booth Operator" className="feature-screen about-screen">
      <p className="screen-kicker">Digit 6</p>
      <h1>About</h1>
      <p>
        Telephone Booth Operator is the control console for a participatory phone installation:
        operators manage prompts, review recorded messages, and keep the line healthy from one
        place.
      </p>
      <section className="feature-card feature-card--wide">
        <h2>Design philosophy</h2>
        <p>
          The interface uses a red telephone accent as a warm signal, but keeps the console clean,
          readable, and task-first.
        </p>
      </section>
      <section className="feature-card feature-card--wide">
        <h2>Stack credits</h2>
        <p>
          React 18, Vite, TanStack Router, TanStack Query, TypeScript, Zod, Vitest, and an Hono API
          keep the line connected.
        </p>
      </section>
      <section className="feature-card feature-card--wide">
        <h2>License and source</h2>
        <p>
          Licensed Apache-2.0. Source lives on{" "}
          <a href="https://github.com/djensenius/Telephone-Booth-Operator">GitHub</a>.
        </p>
      </section>
    </GlassPanel>
  );
}
