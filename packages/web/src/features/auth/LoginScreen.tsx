import { ContempraPhone, GlassPanel, Handset } from "../../components/booth/index.js";

export function LoginScreen(): JSX.Element {
  return (
    <GlassPanel title="Operator login" className="login-screen">
      <p className="screen-kicker">Answering service</p>
      <h1>Pick up to sign in</h1>
      <p>Drag the handset into the chrome cradle or focus it and press Enter to begin Authentik login.</p>
      <div className="login-screen__phone">
        <ContempraPhone showDial={false} />
        <Handset />
      </div>
    </GlassPanel>
  );
}
