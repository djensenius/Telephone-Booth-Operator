import { lazyRouteComponent, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { z } from "zod";
import { BoothFrame, CeilingLamps, ContempraPhone, LineBusyPlacard, TelephoneBanner } from "../components/booth/index.js";
import { useNumericNavigation } from "../hooks/useNumericNavigation.js";
import { ROTARY_ROUTES, isRouteStatusFilter } from "../lib/navigation.js";

const messagesSearchSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

function AppLayout(): JSX.Element {
  useNumericNavigation();
  return (
    <BoothFrame>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <TelephoneBanner />
      <CeilingLamps />
      <div className="app-shell">
        <aside className="operator-sidebar" aria-label="Operator navigation">
          <nav className="operator-sidebar__nav" aria-label="Rotary digit routes">
            <h2>Switchboard</h2>
            <ul>
              {ROTARY_ROUTES.map((route) => (
                <li key={route.digit}>
                  {route.reserved === true ? (
                    <span className="operator-sidebar__reserved">{route.digit} · Reserved</span>
                  ) : (
                    <a href={route.href}>{route.digit} · {route.label}</a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
          <ContempraPhone />
        </aside>
        <main className="app-shell__main" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <LineBusyPlacard />
    </BoothFrame>
  );
}

const rootRoute = createRootRoute({ component: AppLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../features/status/StatusScreen.js"), "StatusScreen"),
});

const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: lazyRouteComponent(() => import("../features/status/StatusScreen.js"), "StatusScreen"),
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages",
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = messagesSearchSchema.safeParse(search);
    if (parsed.success) {
      return parsed.data;
    }
    const status = search.status;
    return isRouteStatusFilter(status) ? { status } : {};
  },
  component: lazyRouteComponent(() => import("../features/messages/MessagesScreen.js"), "MessagesScreen"),
});

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/questions",
  component: lazyRouteComponent(() => import("../features/questions/QuestionsScreen.js"), "QuestionsScreen"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("../features/tokens/SettingsScreen.js"), "SettingsScreen"),
});

const debugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug",
  component: lazyRouteComponent(() => import("../features/debug/DebugScreen.js"), "DebugScreen"),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazyRouteComponent(() => import("../features/auth/LoginScreen.js"), "LoginScreen"),
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: lazyRouteComponent(() => import("../features/about/AboutScreen.js"), "AboutScreen"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  statusRoute,
  messagesRoute,
  questionsRoute,
  settingsRoute,
  debugRoute,
  loginRoute,
  aboutRoute,
]);

export function createAppRouter(options: { readonly history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    ...(options.history === undefined ? {} : { history: options.history }),
    defaultPreload: "intent",
    defaultPendingMinMs: 0,
  });
}

export const router = createAppRouter();

export type AppRouter = typeof router;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
