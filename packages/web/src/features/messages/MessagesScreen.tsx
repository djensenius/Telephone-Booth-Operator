import { useSearch } from "@tanstack/react-router";
import { GlassPanel } from "../../components/booth/index.js";
import { isRouteStatusFilter } from "../../lib/navigation.js";

export function MessagesScreen(): JSX.Element {
  const search = useSearch({ strict: false });
  const status = isRouteStatusFilter(search.status) ? search.status : "all";
  return (
    <GlassPanel title="Message review queue">
      <p className="screen-kicker">Digits 2–4</p>
      <h1>Messages</h1>
      <p>Placeholder queue filtered to <strong>{status}</strong> messages.</p>
    </GlassPanel>
  );
}
