export type NavigationDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "0";

export type RouteStatusFilter = "pending" | "approved" | "rejected";

// Queue filters shown on /messages. "needs-review" spans two backend statuses
// (`received` before the AI worker claims a message, `pending` while its work
// is in flight), so it is narrowed client-side rather than sent as `?status=`.
export type MessageRouteFilter = "all" | "needs-review" | "approved" | "rejected" | "uploading";

export const MESSAGE_ROUTE_FILTERS: readonly MessageRouteFilter[] = [
  "all",
  "needs-review",
  "approved",
  "rejected",
  "uploading",
];

const MESSAGE_FILTER_LABELS: Record<MessageRouteFilter, string> = {
  all: "All",
  "needs-review": "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  uploading: "Uploading",
};

export function messageFilterLabel(filter: MessageRouteFilter): string {
  return MESSAGE_FILTER_LABELS[filter];
}

export interface DigitRoute {
  readonly digit: NavigationDigit;
  readonly label: string;
  readonly href: string;
  readonly reserved?: boolean;
  readonly adminOnly?: boolean;
}

export const DIGIT_ROUTES: readonly DigitRoute[] = [
  { digit: "1", label: "Status", href: "/status" },
  { digit: "2", label: "Messages", href: "/messages" },
  { digit: "3", label: "Questions", href: "/questions" },
  { digit: "4", label: "Tokens", href: "/tokens", adminOnly: true },
  { digit: "5", label: "Settings", href: "/settings" },
  { digit: "6", label: "About", href: "/about" },
  { digit: "7", label: "Logout", href: "/logout" },
  { digit: "8", label: "Instructions", href: "/instructions", adminOnly: true },
  { digit: "9", label: "Debug", href: "/debug", adminOnly: true },
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
  return MESSAGE_ROUTE_FILTERS.some((filter) => filter === value);
}
