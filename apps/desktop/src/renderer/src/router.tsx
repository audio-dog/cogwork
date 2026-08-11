import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ActivityScreen } from "./features/activity-screen";
import { OverviewScreen } from "./features/overview-screen";
import { RootLayout } from "./features/root-layout";

const rootRoute = createRootRoute({ component: RootLayout });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewScreen,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityScreen,
});

const routeTree = rootRoute.addChildren([overviewRoute, activityRoute]);

// The renderer loads from file:// in production, so keep routing in memory rather
// than tying it to the document URL.
export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
