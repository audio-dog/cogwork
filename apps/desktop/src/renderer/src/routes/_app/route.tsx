import { Button } from "@cogwork/ui/components/button";
import { SidebarInset, SidebarTrigger } from "@cogwork/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiLayoutRightLine } from "@remixicon/react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ActivityViewProvider } from "../../components/activity-view";
import { AppSidebar } from "../../components/nav-sidebar";
import { RightPanel } from "../../components/right-panel";
import { RightPanelResizeHandle, useRightPanelWidthActions } from "../../components/right-panel-resize";
import { PausedBanner, SchedulerControls } from "../../components/scheduler-gauges";
import { SidebarResizeHandle, useSidebarWidth } from "../../components/sidebar-resize";
import { useRightPanelStore } from "../../store/right-panel";

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

// Always mounted so opening and closing animates its width, like the left sidebar's
// offcanvas slide. Collapsed to zero width when closed; the inner column keeps a
// fixed width so the content does not reflow mid-slide.
function RightPanelRegion({ open }: { open: boolean }) {
  return (
    <div
      data-slot="right-panel-region"
      inert={!open ? true : undefined}
      aria-hidden={!open ? true : undefined}
      className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear",
        open ? "w-[var(--right-panel-width)] border-l" : "w-0",
      )}
    >
      <div className="h-full w-[var(--right-panel-width)]">
        <RightPanel />
      </div>
    </div>
  );
}

function ContentArea({
  onRightPanelCommit,
  onRightPanelReset,
}: {
  onRightPanelCommit: (width: number) => void;
  onRightPanelReset: () => void;
}) {
  const panelOpen = useRightPanelStore((store) => store.open);
  const maximized = useRightPanelStore((store) => store.maximized);

  if (panelOpen && maximized) return <RightPanel />;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <MainColumn />
      </div>
      {panelOpen && <RightPanelResizeHandle onCommit={onRightPanelCommit} onReset={onRightPanelReset} />}
      <RightPanelRegion open={panelOpen} />
    </div>
  );
}

function AppShell() {
  const { setWidth, reset } = useSidebarWidth();
  const rightPanel = useRightPanelWidthActions();

  return (
    <>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <ActivityViewProvider>
          <ContentArea onRightPanelCommit={rightPanel.setWidth} onRightPanelReset={rightPanel.reset} />
        </ActivityViewProvider>
      </SidebarInset>
      <SidebarControl />
      <SidebarResizeHandle onCommit={setWidth} onReset={reset} />
    </>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppShell,
});
