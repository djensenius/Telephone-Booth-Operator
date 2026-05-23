import { useBoothStatus } from "./BoothStatusContext.js";

export function CeilingLamps(): JSX.Element {
  const { status } = useBoothStatus();
  return (
    <div className={`ceiling-lamps ceiling-lamps--${status}`} aria-label={`Booth status: ${status}`} role="status">
      <span className="ceiling-lamps__lamp ceiling-lamps__lamp--left" />
      <span className="ceiling-lamps__lamp ceiling-lamps__lamp--center" />
      <span className="ceiling-lamps__lamp ceiling-lamps__lamp--right" />
    </div>
  );
}
