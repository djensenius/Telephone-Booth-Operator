// Vitest global setup. Pins locale + timezone so snapshot tests that
// render dates via `toLocaleString()` are deterministic across machines
// (Mac dev: en-CA / America/Toronto vs CI Ubuntu: en-US / UTC).

import { afterAll, beforeAll } from "vite-plus/test";

const FIXED_LOCALE = "en-CA";
const FIXED_TIME_ZONE = "America/Toronto";

type LocaleMethod = (
  this: Date,
  locale?: Intl.LocalesArgument,
  options?: Intl.DateTimeFormatOptions,
) => string;

const proto = Date.prototype;
/* oxlint-disable @typescript-eslint/unbound-method -- intentionally
   capturing the prototype methods to monkey-patch them, then restoring. */
const originals = {
  toLocaleString: proto.toLocaleString,
  toLocaleDateString: proto.toLocaleDateString,
  toLocaleTimeString: proto.toLocaleTimeString,
};
/* oxlint-enable @typescript-eslint/unbound-method */

function withFixedZone(
  options: Intl.DateTimeFormatOptions | undefined,
): Intl.DateTimeFormatOptions {
  return { ...options, timeZone: options?.timeZone ?? FIXED_TIME_ZONE };
}

function makePinned(original: LocaleMethod): LocaleMethod {
  return function pinnedLocaleMethod(
    this: Date,
    locale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return original.call(this, locale ?? FIXED_LOCALE, withFixedZone(options));
  };
}

beforeAll(() => {
  proto.toLocaleString = makePinned(originals.toLocaleString);
  proto.toLocaleDateString = makePinned(originals.toLocaleDateString);
  proto.toLocaleTimeString = makePinned(originals.toLocaleTimeString);
});

afterAll(() => {
  proto.toLocaleString = originals.toLocaleString;
  proto.toLocaleDateString = originals.toLocaleDateString;
  proto.toLocaleTimeString = originals.toLocaleTimeString;
});
