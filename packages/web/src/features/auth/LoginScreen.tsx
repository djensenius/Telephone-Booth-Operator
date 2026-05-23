import { useSearch } from "@tanstack/react-router";
import { ContempraPhone, GlassPanel, Handset } from "../../components/booth/index.js";

function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : window.location.pathname;
}

export function LoginScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const returnTo = safeReturnTo(search.return_to);

  function beginLogin(): void {
    window.location.href = `/v1/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  }

  return (
    <GlassPanel title="Operator login" className="login-screen">
      <p className="screen-kicker">Answering service</p>
      <h1>Place a call to begin</h1>
      <p>Pick up the receiver and connect through the operator identity provider. Cookie-based sessions keep the line warm after sign-in.</p>
      <button className="feature-primary-button" type="button" onClick={beginLogin}>Sign in with Authentik</button>
      <div className="login-screen__phone" aria-hidden="true">
        <ContempraPhone showDial={false} />
        <Handset />
      </div>
    </GlassPanel>
  );
}
