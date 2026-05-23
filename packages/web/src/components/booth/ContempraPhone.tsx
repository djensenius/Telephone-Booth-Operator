import { RotaryDial } from "./RotaryDial.js";

export interface ContempraPhoneProps {
  readonly disabled?: boolean;
  readonly showDial?: boolean;
}

export function ContempraPhone({ disabled = false, showDial = true }: ContempraPhoneProps): JSX.Element {
  return (
    <div className="contempra-phone">
      <svg className="contempra-phone__body" viewBox="0 0 320 520" aria-hidden="true">
        <path className="contempra-phone__shadow" d="M60 500 C30 420 36 160 88 42 C126 10 204 10 238 42 C292 168 292 418 256 500 Z" />
        <path className="contempra-phone__shell" d="M70 492 C42 420 48 165 96 52 C130 24 198 24 228 52 C278 172 278 420 246 492 Z" />
        <rect className="contempra-phone__cradle" x="86" y="54" width="148" height="44" rx="22" data-handset-cradle="true" />
        <path className="contempra-phone__chrome" d="M102 110 H218 C229 110 238 119 238 130 V168 H82 V130 C82 119 91 110 102 110 Z" />
        <rect className="contempra-phone__label" x="106" y="180" width="108" height="30" rx="8" />
      </svg>
      {showDial ? <div className="contempra-phone__dial"><RotaryDial disabled={disabled} /></div> : null}
    </div>
  );
}
