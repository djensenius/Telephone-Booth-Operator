import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auth } from "../../lib/api-client.js";

export function LogoutButton(): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await auth.logout();
    } finally {
      queryClient.clear();
      setBusy(false);
      void navigate({ to: "/login", replace: true });
    }
  }

  return (
    <button type="button" onClick={() => void logout()} disabled={busy}>
      {busy ? "Clearing the line…" : "Sign out"}
    </button>
  );
}
