import { SidebarProvider } from "@cogwork/ui/components/sidebar";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { CSSProperties } from "react";

import { RightPanelWidthProvider } from "../components/right-panel-resize";
import { useSidebarWidth } from "../components/sidebar-resize";
import { daemonAtomRegistry, primeRootAtoms } from "../daemon/atom-registry";
import { harnessCatalogsAtom, harnessReadinessAtom } from "../daemon/atoms";
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

export const Route = createRootRoute({
  component: RootLayout,
  loader: () => primeRootAtoms(daemonAtomRegistry, harnessCatalogsAtom, harnessReadinessAtom),
});
