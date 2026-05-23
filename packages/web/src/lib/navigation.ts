export type RotaryDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "0";

export type RouteStatusFilter = "pending" | "approved" | "rejected";

export interface RotaryRoute {
  readonly digit: RotaryDigit;
  readonly label: string;
  readonly href: string;
  readonly reserved?: boolean;
}

export const ROTARY_ROUTES: readonly RotaryRoute[] = [
  { digit: "1", label: "Status", href: "/status" },
  { digit: "2", label: "Pending messages", href: "/messages?status=pending" },
  { digit: "3", label: "Approved messages", href: "/messages?status=approved" },
  { digit: "4", label: "Rejected messages", href: "/messages?status=rejected" },
  { digit: "5", label: "Questions", href: "/questions" },
  { digit: "6", label: "Settings", href: "/settings" },
  { digit: "7", label: "Reserved", href: "#reserved-7", reserved: true },
  { digit: "8", label: "Reserved", href: "#reserved-8", reserved: true },
  { digit: "9", label: "Debug", href: "/debug" },
  { digit: "0", label: "About", href: "/about" },
];

const routeByDigit = new Map<RotaryDigit, RotaryRoute>(ROTARY_ROUTES.map((route) => [route.digit, route]));

export function getRouteForDigit(digit: RotaryDigit): RotaryRoute {
  const route = routeByDigit.get(digit);
  if (route === undefined) {
    throw new Error(`Unknown rotary digit: ${digit}`);
  }
  return route;
}

export function isRotaryDigit(value: string): value is RotaryDigit {
  return /^[0-9]$/.test(value);
}

export function isRouteStatusFilter(value: unknown): value is RouteStatusFilter {
  return value === "pending" || value === "approved" || value === "rejected";
}
