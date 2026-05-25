import { useSearch } from "@tanstack/react-router";
import { GlassPanel } from "../../components/booth/index.js";
import { apiUrlFor } from "../../lib/api-client.js";

function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : window.location.pathname;
}

export function LoginScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const returnTo = safeReturnTo(search.return_to);

  function beginLogin(): void {
    window.location.href = apiUrlFor(`/v1/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  return (
    <GlassPanel title="Operator login" className="login-screen">
      <div className="login-screen__layout">
        <div className="login-screen__copy">
          <p className="screen-kicker">Secure operator line</p>
          <h1>Sign in to connect</h1>
          <p className="login-screen__status" role="status">
            You are not logged in.
          </p>
          <p>
            Authenticate with the operator identity provider to review calls, manage prompts, and
            monitor the installation.
          </p>
          <button className="feature-primary-button" type="button" onClick={beginLogin}>
            Sign in with Authentik
          </button>
        </div>
        <div className="login-screen__flourish" aria-hidden="true">
          <svg viewBox="0 0 180 150">
            <path
              className="login-screen__phone-receiver"
              d="M48 34h84c10 0 18 8 18 18v9H30v-9c0-10 8-18 18-18Z"
            />
            <path
              className="login-screen__phone-body"
              d="M50 66h80l14 48c2 8-4 16-12 16H48c-8 0-14-8-12-16l14-48Z"
            />
          </svg>
        </div>
      </div>
    </GlassPanel>
  );
}
