import { Button } from "@cogwork/ui/components/button";
import { SidebarInset, SidebarTrigger } from "@cogwork/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCollapseDiagonalLine, RiExpandDiagonalLine, RiLayoutRightLine } from "@remixicon/react";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ActivityViewProvider } from "../../components/activity-view";
import { DaemonConfigurationProvider } from "../../components/configuration-provider";
import { AppSidebar } from "../../components/nav-sidebar";
import { RightPanel } from "../../components/right-panel";
import { RightPanelResizeHandle, useRightPanelWidthActions } from "../../components/right-panel-resize";
import { PausedBanner, SchedulerControls } from "../../components/scheduler-gauges";
import { SidebarResizeHandle, useSidebarWidth } from "../../components/sidebar-resize";
import { DaemonWorkflowProvider } from "../../features/workflow-session";
import { DaemonWorkingCopiesProvider } from "../../features/working-copy-provider";
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
  return (
    <header className="flex h-11 min-h-11 shrink-0 items-center gap-4 border-b pr-[calc(var(--workspace-controls-right)+2.25rem)] pl-4 [-webkit-app-region:drag]">
      <div className="ml-auto flex items-center gap-4 [-webkit-app-region:no-drag]">
        <SchedulerControls />
      </div>
    </header>
  );
}

function RightPanelControls() {
  const panelOpen = useRightPanelStore((store) => store.open);
  const maximized = useRightPanelStore((store) => store.maximized);
  const togglePanel = useRightPanelStore((store) => store.togglePanel);
  const toggleMaximized = useRightPanelStore((store) => store.toggleMaximized);
  const maximizeLabel = maximized ? "Restore panel" : "Expand panel";
  const panelLabel = panelOpen ? "Hide side panel" : "Show side panel";
  const panelVariant = panelOpen ? "secondary" : "ghost";

  return (
    <div className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-10 flex h-11 items-center gap-1 [-webkit-app-region:no-drag]">
      {panelOpen && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button aria-label={maximizeLabel} size="icon-sm" variant="ghost" onClick={toggleMaximized}>
                {maximized ? <RiCollapseDiagonalLine /> : <RiExpandDiagonalLine />}
              </Button>
            }
          />
          <TooltipContent side="bottom">{maximizeLabel}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button aria-label={panelLabel} size="icon-sm" variant={panelVariant} onClick={togglePanel}>
              <RiLayoutRightLine />
            </Button>
          }
        />
        <TooltipContent side="bottom">{panelLabel}</TooltipContent>
      </Tooltip>
    </div>
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
  const content =
    panelOpen && maximized ? (
      <RightPanel />
    ) : (
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1">
          <MainColumn />
        </div>
        {panelOpen && <RightPanelResizeHandle onCommit={onRightPanelCommit} onReset={onRightPanelReset} />}
        <RightPanelRegion open={panelOpen} />
      </div>
    );

  return (
    <div className="relative h-full min-h-0">
      {content}
      <RightPanelControls />
    </div>
  );
}

function AppShell() {
  const { setWidth, reset } = useSidebarWidth();
  const rightPanel = useRightPanelWidthActions();

  return (
    <DaemonConfigurationProvider>
      <DaemonWorkflowProvider>
        <DaemonWorkingCopiesProvider>
          <AppSidebar />
          <SidebarInset className="h-svh overflow-hidden">
            <ActivityViewProvider>
              <ContentArea onRightPanelCommit={rightPanel.setWidth} onRightPanelReset={rightPanel.reset} />
            </ActivityViewProvider>
          </SidebarInset>
          <SidebarControl />
          <SidebarResizeHandle onCommit={setWidth} onReset={reset} />
        </DaemonWorkingCopiesProvider>
      </DaemonWorkflowProvider>
    </DaemonConfigurationProvider>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppShell,
});
