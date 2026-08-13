import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@cogwork/ui/components/resizable";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@cogwork/ui/components/sidebar";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiLayoutRightLine } from "@remixicon/react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import type { ComponentProps, CSSProperties } from "react";
import { NavSidebar } from "../components/nav-sidebar";
import { RightPanel } from "../components/right-panel";
import { PausedBanner, SchedulerControls } from "../components/scheduler-gauges";
import { SidebarResizeHandle, useSidebarWidth } from "../components/sidebar-resize";
import { type EngineStatusValue, engineIsOn, useEngineStatus } from "../features/use-engine-status";
import { useRightPanelStore } from "../store/right-panel";

const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const engineBadge: Record<EngineStatusValue, { label: string; variant: BadgeVariant }> = {
  unknown: { label: "…", variant: "outline" },
  starting: { label: "Starting", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  adopted: { label: "Adopted", variant: "default" },
  stopped: { label: "Stopped", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

function EngineControl() {
  const { status, setEnabled } = useEngineStatus();
  const badge = engineBadge[status];
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Engine</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <Switch
        aria-label="Toggle engine"
        checked={engineIsOn(status)}
        disabled={status === "starting"}
        onCheckedChange={setEnabled}
      />
    </div>
  );
}

// Rendered outside the sidebar so it stays put when the sidebar collapses.
function SidebarControl() {
  return (
    <div className="pointer-events-none fixed top-0 left-[var(--workspace-controls-left)] z-50 flex h-11 items-center">
      <Tooltip>
        <TooltipTrigger
          render={<SidebarTrigger className="pointer-events-auto [-webkit-app-region:no-drag]" />}
        />
        <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ShellHeader() {
  const togglePanel = useRightPanelStore((store) => store.togglePanel);
  const panelOpen = useRightPanelStore((store) => store.open);

  return (
    <header className="flex h-11 min-h-11 shrink-0 items-center gap-4 border-b pr-4 pl-4 [-webkit-app-region:drag]">
      <div className="ml-auto flex items-center gap-4 [-webkit-app-region:no-drag]">
        <SchedulerControls />
        <EngineControl />
        <Button
          aria-label={panelOpen ? "Hide side panel" : "Show side panel"}
          size="icon-sm"
          variant={panelOpen ? "secondary" : "ghost"}
          onClick={togglePanel}
        >
          <RiLayoutRightLine />
        </Button>
      </div>
    </header>
  );
}

function MainColumn() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <ShellHeader />
      <PausedBanner />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

function ContentArea() {
  const panelOpen = useRightPanelStore((store) => store.open);
  const maximized = useRightPanelStore((store) => store.maximized);

  if (panelOpen && maximized) return <RightPanel />;

  if (panelOpen) {
    return (
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="64%" minSize="30%">
          <MainColumn />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="36%" minSize="24%" maxSize="55%">
          <RightPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return <MainColumn />;
}

function RootLayout() {
  const { width, setWidth, reset } = useSidebarWidth();
  // Wider on macOS so the fixed toggle and title-bar content clear the traffic lights.
  const controlsLeft = isMac ? "90px" : "0.75rem";
  const providerStyle = {
    "--sidebar-width": `${width}px`,
    "--workspace-controls-left": controlsLeft,
    "--workspace-titlebar-content-left": `calc(${controlsLeft} + 1.75rem + 0.5rem)`,
  } as CSSProperties;

  return (
    <TooltipProvider>
      <SidebarProvider style={providerStyle}>
        <NavSidebar />
        <SidebarInset className="h-svh overflow-hidden">
          <ContentArea />
        </SidebarInset>
        <SidebarControl />
        <SidebarResizeHandle onCommit={setWidth} onReset={reset} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
