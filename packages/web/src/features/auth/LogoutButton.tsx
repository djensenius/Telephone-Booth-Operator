import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrlFor } from "../../lib/api-client.js";

export function LogoutButton(): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  function prepareLogout(): void {
    queryClient.clear();
    setBusy(true);
  }

  return (
    <form method="post" action={apiUrlFor("/v1/auth/logout")} onSubmit={prepareLogout}>
      <button type="submit" disabled={busy}>
        {busy ? "Clearing the line…" : "Sign out"}
      </button>
    </form>
  );
}
