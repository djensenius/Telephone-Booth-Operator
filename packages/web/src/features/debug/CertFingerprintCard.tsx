export interface CertFingerprintCardProps {
  readonly fingerprint: string;
}

export function CertFingerprintCard({ fingerprint }: CertFingerprintCardProps): JSX.Element {
  async function copy(): Promise<void> {
    await navigator.clipboard?.writeText(fingerprint);
  }

  return (
    <section className="debug-panel debug-panel--compact" aria-labelledby="debug-cert-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">LAN cert</p>
        <h2 id="debug-cert-heading">Pinned fingerprint</h2>
      </div>
      {fingerprint.length === 0 ? (
        <p>
          No LAN certificate pinned yet. Pin it from Settings before using the self-signed LAN
          fallback.
        </p>
      ) : (
        <div className="debug-fingerprint">
          <code>{fingerprint}</code>
          <button type="button" onClick={() => void copy()}>
            Copy fingerprint
          </button>
        </div>
      )}
    </section>
  );
}
