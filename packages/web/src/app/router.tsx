import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { z } from "zod";
import { BoothFrame, CeilingLamps, ContempraPhone, LineBusyPlacard, TelephoneBanner } from "../components/booth/index.js";
import { AboutScreen } from "../features/about/AboutScreen.js";
import { LoginScreen } from "../features/auth/LoginScreen.js";
import { RequireAuth } from "../features/auth/RequireAuth.js";
import { DebugScreen } from "../features/debug/DebugScreen.js";
import { EventsScreen } from "../features/events/EventsScreen.js";
import { MessageDetail } from "../features/messages/MessageDetail.js";
import { MessagesScreen } from "../features/messages/MessagesScreen.js";
import { QuestionsScreen } from "../features/questions/QuestionsScreen.js";
import { SessionDetailScreen, SessionsScreen } from "../features/sessions/SessionsScreen.js";
import { SettingsScreen } from "../features/settings/SettingsScreen.js";
import { StatusScreen } from "../features/status/StatusScreen.js";
import { LiveSystemPanel } from "../features/system/LiveSystemPanel.js";
import { TokensScreen } from "../features/tokens/TokensScreen.js";
import { useNumericNavigation } from "../hooks/useNumericNavigation.js";
import { ROTARY_ROUTES, isMessageFilter } from "../lib/navigation.js";

const messagesSearchSchema = z.object({
  status: z.enum(["all", "received", "uploading", "failed"]).optional(),
});

const loginSearchSchema = z.object({
  return_to: z.string().optional(),
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
                    <a href={route.href}>{`${route.digit} · ${route.label}`}</a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
          <nav className="operator-sidebar__nav" aria-label="Observability routes">
            <h2>Observability</h2>
            <ul>
              <li><a href="/system">Live system</a></li>
              <li><a href="/events">Events</a></li>
              <li><a href="/sessions">Sessions</a></li>
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

function protectedScreen(screen: JSX.Element): JSX.Element {
  return <RequireAuth>{screen}</RequireAuth>;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => protectedScreen(<StatusScreen />),
});

const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: () => protectedScreen(<StatusScreen />),
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages",
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = messagesSearchSchema.safeParse(search);
    if (parsed.success) return parsed.data;
    return isMessageFilter(search.status) ? { status: search.status } : {};
  },
  component: () => protectedScreen(<MessagesScreen />),
});

const messageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages/$id",
  component: () => protectedScreen(<MessageDetail />),
});

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/questions",
  component: () => protectedScreen(<QuestionsScreen />),
});

const newQuestionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/questions/new",
  component: () => protectedScreen(<QuestionsScreen startNew />),
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tokens",
  component: () => protectedScreen(<TokensScreen />),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => protectedScreen(<SettingsScreen />),
});

const debugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug",
  component: () => protectedScreen(<DebugScreen />),
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: () => protectedScreen(<LiveSystemPanel />),
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events",
  component: () => protectedScreen(<EventsScreen />),
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: () => protectedScreen(<SessionsScreen />),
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: () => {
    const { id } = sessionDetailRoute.useParams();
    return protectedScreen(<SessionDetailScreen id={id} />);
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => loginSearchSchema.parse(search),
  component: LoginScreen,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  statusRoute,
  messagesRoute,
  messageDetailRoute,
  questionsRoute,
  newQuestionRoute,
  tokensRoute,
  settingsRoute,
  debugRoute,
  systemRoute,
  eventsRoute,
  sessionsRoute,
  sessionDetailRoute,
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
