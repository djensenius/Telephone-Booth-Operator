import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getReducedMotionPreference } from "../../lib/motion.js";
import { ROTARY_ROUTES } from "../../lib/navigation.js";
import type { RotaryDigit } from "../../lib/navigation.js";
import { playDialClicks } from "../../lib/sounds.js";
import { useBoothStatus } from "./BoothStatusContext.js";

export interface RotaryDialProps {
  readonly disabled?: boolean;
  readonly decorativeLabel?: string;
}

interface DigitPosition {
  readonly digit: RotaryDigit;
  readonly x: number;
  readonly y: number;
  readonly turn: number;
}

const digitPositions: readonly DigitPosition[] = [
  { digit: "1", x: 70, y: 20, turn: 70 },
  { digit: "2", x: 82, y: 34, turn: 95 },
  { digit: "3", x: 84, y: 52, turn: 120 },
  { digit: "4", x: 74, y: 69, turn: 145 },
  { digit: "5", x: 57, y: 79, turn: 170 },
  { digit: "6", x: 38, y: 79, turn: 195 },
  { digit: "7", x: 22, y: 68, turn: 220 },
  { digit: "8", x: 14, y: 51, turn: 245 },
  { digit: "9", x: 18, y: 33, turn: 270 },
  { digit: "0", x: 50, y: 90, turn: 300 },
];

function stepsForDigit(digit: RotaryDigit): number {
  return digit === "0" ? 10 : Number.parseInt(digit, 10);
}

export function RotaryDial({ disabled = false, decorativeLabel = "Rotary navigation dial" }: RotaryDialProps): JSX.Element {
  const navigate = useNavigate();
  const { muted, reducedMotionOverride, connectionStatus } = useBoothStatus();
  const [activeDigit, setActiveDigit] = useState<RotaryDigit | null>(null);
  const [reduceMotion, setReduceMotion] = useState(getReducedMotionPreference);
  const isDisabled = disabled || connectionStatus === "disconnected";
  const staticDial = reduceMotion && !reducedMotionOverride;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (): void => setReduceMotion(query.matches);
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const activeTurn = useMemo(() => digitPositions.find((position) => position.digit === activeDigit)?.turn ?? 0, [activeDigit]);

  function navigateDigit(digit: RotaryDigit): void {
    switch (digit) {
      case "1":
        void navigate({ to: "/status" });
        break;
      case "2":
        void navigate({ to: "/messages", search: { status: "pending" } });
        break;
      case "3":
        void navigate({ to: "/messages", search: { status: "approved" } });
        break;
      case "4":
        void navigate({ to: "/messages", search: { status: "rejected" } });
        break;
      case "5":
        void navigate({ to: "/questions" });
        break;
      case "6":
        void navigate({ to: "/settings" });
        break;
      case "9":
        void navigate({ to: "/debug" });
        break;
      case "0":
        void navigate({ to: "/about" });
        break;
      case "7":
      case "8":
        break;
    }
  }

  function handleDial(digit: RotaryDigit): void {
    if (isDisabled) {
      return;
    }
    const route = ROTARY_ROUTES.find((candidate) => candidate.digit === digit);
    if (route?.reserved === true) {
      return;
    }
    if (!staticDial) {
      setActiveDigit(digit);
      window.setTimeout(() => setActiveDigit(null), 700);
      playDialClicks(stepsForDigit(digit), { muted, allowReducedMotionAudio: reducedMotionOverride });
    }
    navigateDigit(digit);
  }

  return (
    <div className={staticDial ? "rotary-dial rotary-dial--reduced" : "rotary-dial"} aria-label={decorativeLabel}>
      <svg className="rotary-dial__plate" viewBox="0 0 200 200" aria-hidden="true">
        <circle className="rotary-dial__outer" cx="100" cy="100" r="94" />
        <circle className="rotary-dial__finger-stop" cx="150" cy="168" r="10" />
        <g className={activeDigit === null ? "rotary-dial__wheel" : "rotary-dial__wheel rotary-dial__wheel--active"} style={{ "--dial-turn": `${activeTurn}deg` } as CSSProperties}>
          <circle className="rotary-dial__wheel-face" cx="100" cy="100" r="72" />
          {digitPositions.map((position) => (
            <circle key={position.digit} className="rotary-dial__hole" cx={position.x * 2} cy={position.y * 2} r="14" />
          ))}
        </g>
        <circle className="rotary-dial__center" cx="100" cy="100" r="27" />
      </svg>
      {digitPositions.map((position) => {
        const route = ROTARY_ROUTES.find((candidate) => candidate.digit === position.digit);
        const label = route === undefined ? "Reserved" : route.label;
        const reserved = route?.reserved === true;
        return (
          <button
            className="rotary-dial__button"
            disabled={isDisabled || reserved}
            key={position.digit}
            type="button"
            aria-label={`Dial ${position.digit} — ${label}`}
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
            onClick={() => handleDial(position.digit)}
          >
            <span>{position.digit}</span>
          </button>
        );
      })}
    </div>
  );
}
