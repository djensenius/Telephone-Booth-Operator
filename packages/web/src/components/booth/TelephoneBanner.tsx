export function TelephoneBanner(): JSX.Element {
  return (
    <header className="telephone-banner" aria-label="Application header">
      <a
        className="telephone-banner__brand"
        href="/status"
        aria-label="Telephone Booth Operator home"
      >
        <span className="telephone-banner__copy">
          <span className="telephone-banner__eyebrow">Operator console</span>
          <span className="telephone-banner__title">Telephone Booth</span>
        </span>
      </a>
      <p className="telephone-banner__tagline">
        Calls, questions, and system status for the installation.
      </p>
    </header>
  );
}
