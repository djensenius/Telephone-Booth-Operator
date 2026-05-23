import { useState } from "react";
import type { FormEvent } from "react";
import type { ApiToken } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useApiTokenUsage, useApiTokensList, useCreateApiToken, useRevokeApiToken } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

function date(value: string | null): string {
  return value === null ? "Never" : new Date(value).toLocaleDateString();
}

function UsageSparkline({ tokenId }: { readonly tokenId: string }): JSX.Element {
  const usage = useApiTokenUsage(tokenId);
  const buckets = usage.data ?? [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const points = buckets.length === 0 ? "0,24 80,24" : buckets.map((bucket, index) => `${(index / Math.max(1, buckets.length - 1)) * 80},${24 - (bucket.count / max) * 22}`).join(" ");
  return <svg className="token-sparkline" viewBox="0 0 80 26" role="img" aria-label={usage.isLoading ? "Loading token usage" : `${buckets.length} usage buckets`}><polyline points={points} /></svg>;
}

export function NewTokenDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): JSX.Element | null {
  const createToken = useCreateApiToken();
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const created = await createToken.mutateAsync({ name, ...(expiresInDays.trim() ? { expiresInDays: Number(expiresInDays) } : {}) });
    setPlaintext(created.plaintext);
    setName("");
    setExpiresInDays("");
  }

  async function copy(): Promise<void> {
    if (plaintext !== null) await navigator.clipboard.writeText(plaintext);
  }

  return (
    <section className="feature-dialog" role="dialog" aria-modal="true" aria-labelledby="new-token-heading">
      <h2 id="new-token-heading">Issue API token</h2>
      {plaintext === null ? (
        <form className="feature-form" onSubmit={(event) => void submit(event)}>
          <label>Token name<input value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={64} /></label>
          <label>Expires in days (optional)<input type="number" min="1" max="3650" value={expiresInDays} onChange={(event) => setExpiresInDays(event.currentTarget.value)} /></label>
          {createToken.error ? <FeatureError message="Could not issue the token." /> : null}
          <div className="debug-button-row"><button type="submit" disabled={createToken.isPending}>Issue token</button><button type="button" onClick={onClose}>Cancel</button></div>
        </form>
      ) : (
        <div className="token-once-panel">
          <strong>This token will never be shown again.</strong>
          <code>{plaintext}</code>
          <div className="debug-button-row"><button type="button" onClick={() => void copy()}>Copy token</button><button type="button" onClick={onClose}>Done</button></div>
        </div>
      )}
    </section>
  );
}

function TokenRow({ token, onRevoke }: { readonly token: ApiToken; readonly onRevoke: (token: ApiToken) => void }): JSX.Element {
  return (
    <tr>
      <td>{token.name}</td>
      <td>•••• {token.last4}</td>
      <td>{date(token.lastUsedAt)}</td>
      <td>{date(token.expiresAt)}</td>
      <td><UsageSparkline tokenId={token.id} /></td>
      <td><button type="button" disabled={token.revokedAt !== null} onClick={() => onRevoke(token)}>{token.revokedAt === null ? "Revoke" : "Revoked"}</button></td>
    </tr>
  );
}

export function TokensScreen(): JSX.Element {
  const tokens = useApiTokensList();
  const revoke = useRevokeApiToken();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokeToken, setRevokeToken] = useState<ApiToken | null>(null);
  const rows = tokens.data ?? [];

  return (
    <GlassPanel title="API tokens" className="feature-screen tokens-screen">
      <p className="screen-kicker">Digit 4</p>
      <h1>Tokens</h1>
      <p>Issue and revoke phone-client tokens. Plaintext tokens are displayed once, just like a call you cannot un-place.</p>
      <div className="feature-actions"><button className="feature-primary-button" type="button" onClick={() => setDialogOpen(true)}>New token</button></div>
      {tokens.isLoading ? <FeatureSkeleton /> : null}
      {tokens.error ? <FeatureError message="Could not load API tokens." /> : null}
      {!tokens.isLoading && rows.length === 0 ? <FeatureEmpty title="No tokens issued">Create a token before connecting the phone client.</FeatureEmpty> : null}
      {rows.length === 0 ? null : (
        <div className="feature-table-wrap">
          <table className="feature-table">
            <caption>API tokens</caption>
            <thead><tr><th>Name</th><th>Last four</th><th>Last used</th><th>Expires</th><th>Usage</th><th>Action</th></tr></thead>
            <tbody>{rows.map((token) => <TokenRow key={token.id} token={token} onRevoke={setRevokeToken} />)}</tbody>
          </table>
        </div>
      )}
      <NewTokenDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      {revokeToken === null ? null : (
        <section className="feature-dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-token-heading">
          <h2 id="revoke-token-heading">Revoke {revokeToken.name}?</h2>
          <p>The phone client using this token will hear a busy signal on its next authenticated request.</p>
          <div className="debug-button-row"><button type="button" onClick={() => void revoke.mutateAsync(revokeToken.id).then(() => setRevokeToken(null))}>Confirm revoke</button><button type="button" onClick={() => setRevokeToken(null)}>Cancel</button></div>
        </section>
      )}
    </GlassPanel>
  );
}
