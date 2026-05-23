import type { DragEvent } from "react";
import { playSound } from "../../lib/sounds.js";
import { useBoothStatus } from "./BoothStatusContext.js";

export interface HandsetProps {
  readonly onAnswer?: () => void;
}

function defaultAnswer(): void {
  window.location.assign("/v1/auth/login");
}

function isInsideCradle(event: DragEvent<HTMLButtonElement>): boolean {
  const cradle = document.querySelector<HTMLElement>("[data-handset-cradle='true']");
  if (cradle === null) {
    return false;
  }
  const rect = cradle.getBoundingClientRect();
  const x = Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
  const y = Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function Handset({ onAnswer }: HandsetProps): JSX.Element {
  const { muted, reducedMotionOverride } = useBoothStatus();
  const answer = onAnswer ?? defaultAnswer;

  function triggerAnswer(): void {
    playSound("handset-pickup", { muted, allowReducedMotionAudio: reducedMotionOverride });
    answer();
  }

  return (
    <button
      className="handset"
      type="button"
      draggable
      aria-label="Answer the phone"
      onClick={triggerAnswer}
      onDragEnd={(event) => {
        if (isInsideCradle(event)) {
          triggerAnswer();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          triggerAnswer();
        }
      }}
    >
      <svg className="handset__svg" viewBox="0 0 360 120" aria-hidden="true">
        <path className="handset__body" d="M52 30 C110 6 250 6 308 30 C334 42 338 78 316 94 C294 110 256 106 242 86 C230 70 130 70 118 86 C104 106 66 110 44 94 C22 78 26 42 52 30 Z" />
        <path className="handset__grip" d="M120 50 C154 38 206 38 240 50" />
      </svg>
      <span className="handset__label">Drag handset into cradle or press Enter</span>
    </button>
  );
}
