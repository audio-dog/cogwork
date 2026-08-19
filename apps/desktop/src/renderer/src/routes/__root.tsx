import { SidebarProvider } from "@cogwork/ui/components/sidebar";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useSidebarWidth } from "../components/sidebar-resize";

const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

function RootLayout() {
  const { width } = useSidebarWidth();
  const controlsLeft = isMac ? "90px" : "0.75rem";
  const providerStyle = {
    "--sidebar-width": `${width}px`,
    "--workspace-controls-left": controlsLeft,
    "--workspace-titlebar-content-left": `calc(${controlsLeft} + 1.75rem + 0.5rem)`,
  } as CSSProperties;

  return (
    <TooltipProvider>
      <SidebarProvider style={providerStyle}>
        <Outlet />
      </SidebarProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
