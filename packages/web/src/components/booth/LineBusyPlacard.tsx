import { useBoothStatus } from "./BoothStatusContext.js";

export function LineBusyPlacard(): JSX.Element {
  const { connectionStatus, lastError } = useBoothStatus();
  const visible = connectionStatus === "disconnected";
  return (
    <aside className={visible ? "line-busy-placard line-busy-placard--visible" : "line-busy-placard"} aria-hidden={!visible} aria-live="assertive">
      <strong>LINE BUSY</strong>
      <span>{lastError ?? "Switchboard link disconnected"}</span>
    </aside>
  );
}
