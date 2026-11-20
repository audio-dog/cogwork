import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { RouteError } from "./components/route-error";
import { reportRendererError } from "./features/report-error";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  defaultErrorComponent: RouteError,
  defaultOnCatch: (error) => reportRendererError(error, "router"),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    pageTitle?: string;
  }
}
