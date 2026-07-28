import { useEffect, useState } from "react";

// Relative timestamps ("5m ago") are computed during render, so on a screen
// that neither polls nor re-renders they would freeze at the value they had
// when the list loaded. This ticks a shared `now` so those labels keep ageing
// while the queue stays open.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}
