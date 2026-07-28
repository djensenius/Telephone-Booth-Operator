import type { JSX, PropsWithChildren } from "react";
import { GlassPanel } from "../../components/booth/index.js";
import { useCurrentUser } from "./useCurrentUser.js";

// Route-level guard for admin-only screens. Assumes it is rendered inside
// `RequireAuth`, so by the time this runs the operator is authenticated and we
// only need to check the admin tier. Non-admins get a read-only notice rather
// than the screen so that a direct URL cannot reach admin tooling.
export function RequireAdmin({ children }: PropsWithChildren): JSX.Element {
  const { isAdmin } = useCurrentUser();
  if (!isAdmin) {
    return (
      <GlassPanel title="Admin access required" className="feature-screen">
        <p className="screen-kicker">Restricted</p>
        <h1>Admin access required</h1>
        <p>
          This console is limited to operator admins. Ask an existing admin to add you to the admin
          group if you need access.
        </p>
      </GlassPanel>
    );
  }
  return <>{children}</>;
}
