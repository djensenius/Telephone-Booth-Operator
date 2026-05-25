import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrlFor } from "../../lib/api-client.js";

interface LogoutButtonProps {
  readonly children?: string;
  readonly className?: string;
}

export function LogoutButton({ children = "Sign out", className }: LogoutButtonProps): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  function prepareLogout(): void {
    queryClient.clear();
    setBusy(true);
  }

  return (
    <form method="post" action={apiUrlFor("/v1/auth/logout")} onSubmit={prepareLogout}>
      <button type="submit" disabled={busy} className={className}>
        {busy ? "Clearing the line…" : children}
      </button>
    </form>
  );
}
