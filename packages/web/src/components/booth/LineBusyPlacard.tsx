import { useBoothStatus } from "./BoothStatusContext.js";

export interface LineBusyPlacardProps {
  readonly inline?: boolean;
  readonly message?: string;
  readonly visible?: boolean;
}

export function LineBusyPlacard({ inline = false, message, visible: forcedVisible }: LineBusyPlacardProps = {}): JSX.Element {
  const { connectionStatus, lastError } = useBoothStatus();
  const visible = forcedVisible ?? connectionStatus === "disconnected";
  const classes = ["line-busy-placard", inline ? "line-busy-placard--inline" : "", visible ? "line-busy-placard--visible" : ""].filter(Boolean).join(" ");
  return (
    <aside className={classes} aria-hidden={!visible} aria-live="assertive">
      <strong>LINE BUSY</strong>
      <span>{message ?? lastError ?? "Switchboard link disconnected"}</span>
    </aside>
  );
}
