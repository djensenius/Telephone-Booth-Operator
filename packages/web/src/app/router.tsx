import type { JSX } from "react";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { z } from "zod";
import { InstallationScopeSchema } from "@telephone-booth-operator/shared";
import type { InstallationScope } from "@telephone-booth-operator/shared";
import {
  BoothStatusBadge,
  BoothFrame,
  LineBusyPlacard,
  TelephoneBanner,
} from "../components/booth/index.js";
import { AboutScreen } from "../features/about/AboutScreen.js";
import { LoginScreen } from "../features/auth/LoginScreen.js";
import { LogoutButton } from "../features/auth/LogoutButton.js";
import { RequireAuth } from "../features/auth/RequireAuth.js";
import { RequireAdmin } from "../features/auth/RequireAdmin.js";
import { useCurrentUser } from "../features/auth/useCurrentUser.js";
import { DebugScreen } from "../features/debug/DebugScreen.js";
import { EventsScreen } from "../features/events/EventsScreen.js";
import { InstallationsScreen } from "../features/installations/InstallationsScreen.js";
import { InstructionsScreen } from "../features/instructions/InstructionsScreen.js";
import { MessageDetail } from "../features/messages/MessageDetail.js";
import { MessagesScreen } from "../features/messages/MessagesScreen.js";
import { QuestionsScreen } from "../features/questions/QuestionsScreen.js";
import { SessionDetailScreen, SessionsScreen } from "../features/sessions/SessionsScreen.js";
import { SettingsScreen } from "../features/settings/SettingsScreen.js";
import { StatsScreen } from "../features/stats/StatsScreen.js";
import { StatusScreen } from "../features/status/StatusScreen.js";
import { LiveSystemPanel } from "../features/system/LiveSystemPanel.js";
import { SystemVitalsStrip } from "../features/system/SystemVitalsStrip.js";
import { TokensScreen } from "../features/tokens/TokensScreen.js";
import { useNumericNavigation } from "../hooks/useNumericNavigation.js";
import { BoothEnvelopeBridge, BoothWebSocketProvider } from "../lib/booth-websocket.js";
import { DIGIT_ROUTES, isMessageFilter } from "../lib/navigation.js";

// The scope is validated here rather than only in the picker, so a typo'd or
// tampered `?installationId=` never lingers in router state looking like it
// applies while every screen quietly ignores it.
const installationScopeSearch = InstallationScopeSchema.optional().catch(undefined);

// The per-field fallback has to validate too, or a rejected sibling field is
// enough to let an unparseable scope back into the URL.
const keptScope = (raw: unknown): { installationId?: InstallationScope } => {
  const parsed = installationScopeSearch.parse(raw);
  return parsed === undefined ? {} : { installationId: parsed };
};

// Each field falls back on its own. A stale `status` in a bookmarked URL must
// not take a valid `installationId` down with it, or the operator silently
// lands on the active era instead of the run they linked to.
const messagesSearchSchema = z.object({
  status: z
    .enum(["all", "needs-review", "approved", "rejected", "uploading"])
    .optional()
    .catch(undefined),
  installationId: installationScopeSearch,
});

const statsSearchSchema = z.object({
  installationId: installationScopeSearch,
});

const sessionsSearchSchema = z.object({
  installationId: installationScopeSearch,
});

const eventsSearchSchema = z.object({
  installationId: installationScopeSearch,
});

const loginSearchSchema = z.object({
  return_to: z.string().optional(),
});

const buildDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function BuildFooter(): JSX.Element {
  const buildDateIso = import.meta.env.VITE_BUILD_DATE ?? "1970-01-01T00:00:00.000Z";
  const buildDate = new Date(buildDateIso);
  const formattedBuildDate = buildDateFormatter.format(buildDate);

  return (
    <footer className="build-footer" aria-label="Build information">
      <span>Build date</span>
      <time dateTime={buildDateIso}>{formattedBuildDate}</time>
    </footer>
  );
}

function AppLayout(): JSX.Element {
  const { isAuthenticated, isAdmin } = useCurrentUser();
  useNumericNavigation(isAuthenticated, isAdmin);
  return (
    <BoothWebSocketProvider enabled={isAuthenticated}>
      <BoothEnvelopeBridge />
      <BoothFrame>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <TelephoneBanner />
        <div className={isAuthenticated ? "app-shell" : "app-shell app-shell--public"}>
          {isAuthenticated ? (
            <aside className="operator-sidebar" aria-label="Operator navigation">
              <BoothStatusBadge />
              <SystemVitalsStrip />
              <nav className="operator-sidebar__nav" aria-label="Digit shortcut routes">
                <h2>Shortcuts</h2>
                <ul>
                  {DIGIT_ROUTES.map((route) => (
                    <li key={route.digit}>
                      {route.reserved === true ? (
                        <span className="operator-sidebar__reserved">{route.digit} · Reserved</span>
                      ) : route.adminOnly === true && !isAdmin ? (
                        <span
                          className="operator-sidebar__reserved operator-sidebar__admin-locked"
                          aria-disabled="true"
                          title="Admin only"
                        >
                          {`${route.digit} · ${route.label} · Admin`}
                        </span>
                      ) : route.digit === "7" ? (
                        <LogoutButton className="operator-sidebar__logout">
                          {`${route.digit} · ${route.label}`}
                        </LogoutButton>
                      ) : (
                        <Link to={route.href}>{`${route.digit} · ${route.label}`}</Link>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
              <nav className="operator-sidebar__nav" aria-label="Observability routes">
                <h2>Observability</h2>
                <ul>
                  <li>
                    <Link to="/stats">Stats</Link>
                  </li>
                  <li>
                    <Link to="/system">Live system</Link>
                  </li>
                  <li>
                    <Link to="/events">Events</Link>
                  </li>
                  <li>
                    <Link to="/sessions">Sessions</Link>
                  </li>
                  {isAdmin ? (
                    <li>
                      <Link to="/installations">Installations</Link>
                    </li>
                  ) : null}
                </ul>
              </nav>
            </aside>
          ) : null}
          <main className="app-shell__main" id="main-content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
        <BuildFooter />
        <LineBusyPlacard />
      </BoothFrame>
    </BoothWebSocketProvider>
  );
}

const rootRoute = createRootRoute({ component: AppLayout });

function protectedScreen(screen: JSX.Element): JSX.Element {
  return <RequireAuth>{screen}</RequireAuth>;
}

function adminScreen(screen: JSX.Element): JSX.Element {
  return (
    <RequireAuth>
      <RequireAdmin>{screen}</RequireAdmin>
    </RequireAuth>
  );
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
    return {
      ...(isMessageFilter(search.status) ? { status: search.status } : {}),
      ...keptScope(search.installationId),
    };
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
  component: () => adminScreen(<TokensScreen />),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => protectedScreen(<SettingsScreen />),
});

const debugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug",
  component: () => adminScreen(<DebugScreen />),
});

const instructionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/instructions",
  component: () => adminScreen(<InstructionsScreen />),
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: () => protectedScreen(<LiveSystemPanel />),
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events",
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = eventsSearchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: () => protectedScreen(<EventsScreen />),
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = sessionsSearchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: () => protectedScreen(<SessionsScreen />),
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = statsSearchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: () => protectedScreen(<StatsScreen />),
});

const installationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installations",
  component: () => adminScreen(<InstallationsScreen />),
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
  instructionsRoute,
  systemRoute,
  eventsRoute,
  sessionsRoute,
  statsRoute,
  installationsRoute,
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
