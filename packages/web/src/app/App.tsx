/**
 * App shell — themed Bell Canada booth. The real router + screens land
 * in packages/web/src/app/router.tsx; this placeholder gives `pnpm build`
 * something to compile and proves the theme tokens are wired.
 */
export function App(): JSX.Element {
  return (
    <main className="booth-frame">
      <header className="telephone-banner">
        <svg
          className="bell-hex"
          width="40"
          height="40"
          viewBox="0 0 40 40"
          aria-hidden="true"
        >
          <polygon
            points="20,2 38,11 38,29 20,38 2,29 2,11"
            fill="var(--bell-blue)"
          />
          <text
            x="20"
            y="27"
            textAnchor="middle"
            fontFamily="Cooper Black, serif"
            fontSize="22"
            fill="var(--enamel-white)"
          >
            B
          </text>
        </svg>
        <span className="telephone-banner__title">TELEPHONE</span>
      </header>
      <section className="glass-panel">
        <h1>Operator standing by…</h1>
        <p>
          This shell is a placeholder. The themed Contempra phone, rotary
          dial nav, and feature screens will land in subsequent commits.
        </p>
      </section>
    </main>
  );
}
