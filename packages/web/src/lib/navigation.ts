export type NavigationDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "0";

export type RouteStatusFilter = "pending" | "approved" | "rejected";
export type MessageRouteFilter = "all" | "received" | "uploading" | "failed";

export interface DigitRoute {
  readonly digit: NavigationDigit;
  readonly label: string;
  readonly href: string;
  readonly reserved?: boolean;
}

export const DIGIT_ROUTES: readonly DigitRoute[] = [
  { digit: "1", label: "Status", href: "/status" },
  { digit: "2", label: "Messages", href: "/messages" },
  { digit: "3", label: "Questions", href: "/questions" },
  { digit: "4", label: "Tokens", href: "/tokens" },
  { digit: "5", label: "Settings", href: "/settings" },
  { digit: "6", label: "About", href: "/about" },
  { digit: "7", label: "Auth / logout", href: "/login" },
  { digit: "8", label: "Reserved", href: "#reserved-8", reserved: true },
  { digit: "9", label: "Debug", href: "/debug" },
  { digit: "0", label: "Home", href: "/" },
];

const routeByDigit = new Map<NavigationDigit, DigitRoute>(
  DIGIT_ROUTES.map((route) => [route.digit, route]),
);

export function getRouteForDigit(digit: NavigationDigit): DigitRoute {
  const route = routeByDigit.get(digit);
  if (route === undefined) {
    throw new Error(`Unknown navigation digit: ${digit}`);
  }
  return route;
}

export function isNavigationDigit(value: string): value is NavigationDigit {
  return /^[0-9]$/.test(value);
}

export function isRouteStatusFilter(value: unknown): value is RouteStatusFilter {
  return value === "pending" || value === "approved" || value === "rejected";
}

export function isMessageFilter(value: unknown): value is MessageRouteFilter {
  return value === "all" || value === "received" || value === "uploading" || value === "failed";
}
