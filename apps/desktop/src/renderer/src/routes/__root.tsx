import { SidebarProvider } from "@cogwork/ui/components/sidebar";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type { CSSProperties } from "react";
import { RightPanelWidthProvider } from "../components/right-panel-resize";
import { useSidebarWidth } from "../components/sidebar-resize";
import { harnessesAtom } from "../daemon/atoms";
import { ActivitySessionProvider } from "../features/activity-session";

const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

function RootLayout() {
  const { width } = useSidebarWidth();
  const controlsLeft = isMac ? "90px" : "0.75rem";
  const providerStyle = {
    "--sidebar-width": `${width}px`,
    "--workspace-controls-left": controlsLeft,
    "--workspace-controls-right":
      "calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + 0.75rem)",
    "--workspace-controls-top": "0px",
    "--workspace-titlebar-content-left": `calc(${controlsLeft} + 1.75rem + 0.5rem)`,
  } as CSSProperties;

  return (
    <ActivitySessionProvider>
      <SidebarProvider style={providerStyle}>
        <RightPanelWidthProvider sidebarWidth={width}>
          <Outlet />
          <TanStackDevtools
            plugins={[
              {
                name: "TanStack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
              {
                name: "TanStack Form",
                render: <FormDevtoolsPanel />,
              },
            ]}
          />
        </RightPanelWidthProvider>
      </SidebarProvider>
    </ActivitySessionProvider>
  );
}

export const Route = createRootRouteWithContext<{ readonly registry: AtomRegistry.AtomRegistry }>()({
  // Every provider surface reads this catalog, so the read starts with the route rather than
  // when a page first asks for it. The atom stays the store the components read; this only
  // decides when it is first asked. `staleTime` is infinite because each read spawns every
  // installed Harness's CLI — Settings refreshes it through `router.invalidate` instead.
  loader: ({ context }) => {
    context.registry.get(harnessesAtom);
  },
  staleTime: Number.POSITIVE_INFINITY,
  component: RootLayout,
});
