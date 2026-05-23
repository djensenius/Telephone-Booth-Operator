export function TelephoneBanner(): JSX.Element {
  return (
    <header className="telephone-banner">
      <a className="telephone-banner__brand" href="/status" aria-label="Telephone Booth Operator home">
        <svg className="telephone-banner__logo" width="56" height="48" viewBox="0 0 56 48" role="img" aria-label="Bell Canada hex logo">
          <polygon className="telephone-banner__hex" points="28,2 53,14 53,34 28,46 3,34 3,14" />
          <text className="telephone-banner__logo-letter" x="28" y="32" textAnchor="middle" aria-hidden="true">
            B
          </text>
        </svg>
        <span className="telephone-banner__title">TELEPHONE</span>
      </a>
    </header>
  );
}
