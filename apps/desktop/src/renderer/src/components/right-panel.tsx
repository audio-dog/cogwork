import type { RunId, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCloseLine, RiFileList2Line, RiFocus2Line, RiPulseLine, RiTerminalBoxLine } from "@remixicon/react";
import { type Surface, type SurfaceId, surfaceId, useRightPanelStore } from "../store/right-panel";
import { ActivityTab as ActivityTabBody } from "./activity-tab";
import { AttentionList } from "./attention-rail";
import { CompactEngineGate } from "./engine-gate";
import { ItemTab as ItemTabView } from "./item-tab";
import { SurfaceCatalogCards, SurfaceCatalogMenu } from "./surface-catalog";

const baseTabClassName = "flex h-7 shrink-0 items-center gap-0.5 rounded-md text-xs";

const activeTabClassName = "bg-accent text-foreground";

const inactiveTabClassName = "text-muted-foreground hover:bg-accent/60 hover:text-foreground";

function SurfaceFill({ children }: { children: React.ReactNode }) {
  return (
    <div className="size-full [&>aside]:size-full [&>aside]:w-full [&>aside]:border-l-0">{children}</div>
  );
}

function AttentionPanelBody() {
  return (
    <SurfaceFill>
      <AttentionList />
    </SurfaceFill>
  );
}

function ItemPanelBody({
  workspace,
  workItem,
  runId,
  run,
}: {
  workspace: WorkspaceId;
  workItem: WorkItemId;
  runId?: RunId;
  run?: RunSummary;
}) {
  return <ItemTabView selection={{ workspace, workItem, runId, run }} />;
}

function tabClassName(active: boolean, padding: string) {
  return cn(baseTabClassName, padding, active ? activeTabClassName : inactiveTabClassName);
}

function CloseTabButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={`Close ${label}`} size="icon-xs" variant="ghost" onClick={onClick}>
      <RiCloseLine className="size-3" />
    </Button>
  );
}

function AttentionTab() {
  const active = useRightPanelStore((state) => state.active === "attention");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);

  return (
    <div className={tabClassName(active, "pl-2 pr-1")}>
      <Button className="min-w-0" size="xs" variant="ghost" onClick={() => setActive("attention")}>
        <RiFocus2Line className="size-3.5 shrink-0" />
        <span className="truncate">Attention</span>
      </Button>
      <CloseTabButton label="Attention" onClick={() => closeSurface("attention")} />
    </div>
  );
}

function ActivityTab() {
  const active = useRightPanelStore((state) => state.active === "activity");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);

  return (
    <div className={tabClassName(active, "pl-2 pr-1")}>
      <Button className="min-w-0" size="xs" variant="ghost" onClick={() => setActive("activity")}>
        <RiPulseLine className="size-3.5 shrink-0" />
        <span className="truncate">Activity</span>
      </Button>
      <CloseTabButton label="Activity" onClick={() => closeSurface("activity")} />
    </div>
  );
}

function TerminalTab() {
  const active = useRightPanelStore((state) => state.active === "terminal");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);

  return (
    <div className={tabClassName(active, "pl-2 pr-1")}>
      <Button className="min-w-0" size="xs" variant="ghost" onClick={() => setActive("terminal")}>
        <RiTerminalBoxLine className="size-3.5 shrink-0" />
        <span className="truncate">Terminal</span>
      </Button>
      <CloseTabButton label="Terminal" onClick={() => closeSurface("terminal")} />
    </div>
  );
}

function ItemTab({ surface }: { surface: Extract<Surface, { kind: "item" }> }) {
  const id = surfaceId(surface);
  const active = useRightPanelStore((state) => state.active === id);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);

  return (
    <div className={tabClassName(active, "pl-2 pr-1")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-center gap-1.5"
              onClick={() => setActive(id)}
            >
              <RiFileList2Line className="size-3.5 shrink-0" />
              <span className="truncate">{surface.workItem}</span>
            </button>
          }
        />
        <TooltipContent side="bottom">{surface.workspace}</TooltipContent>
      </Tooltip>
      <CloseTabButton label={surface.workItem} onClick={() => closeSurface(id)} />
    </div>
  );
}

function currentSurface(surfaces: readonly Surface[], active: SurfaceId | null) {
  return surfaces.find((surface) => surfaceId(surface) === active) ?? surfaces[0];
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

function TerminalPanelBody() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiTerminalBoxLine />
        </EmptyMedia>
        <EmptyTitle>Terminal is coming soon</EmptyTitle>
        <EmptyDescription>Terminal sessions will appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function EmptySurfaceCatalog() {
  const openSurface = useRightPanelStore((state) => state.openSurface);
  const maximized = useRightPanelStore((state) => state.maximized);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-11 min-h-11 shrink-0 items-center border-b pr-[calc(var(--workspace-controls-right)+4.25rem)] pl-2 [-webkit-app-region:drag]",
          maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
        )}
      >
        <div className="[-webkit-app-region:no-drag]">
          <h2 className="font-heading text-sm font-medium">Open a surface</h2>
          <p className="text-sm text-muted-foreground">Choose what to show in the right panel.</p>
        </div>
      </div>
      <SurfaceCatalogCards onSelect={(kind) => openSurface({ kind })} />
    </div>
  );
}

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const openSurface = useRightPanelStore((state) => state.openSurface);
  const current = currentSurface(surfaces, active);
  const attentionOpen = surfaces.some((surface) => surface.kind === "attention");
  const activityOpen = surfaces.some((surface) => surface.kind === "activity");
  const terminalOpen = surfaces.some((surface) => surface.kind === "terminal");

  if (!current) return <EmptySurfaceCatalog />;

  const itemSurfaces = surfaces.filter(
    (surface): surface is Extract<Surface, { kind: "item" }> => surface.kind === "item",
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-11 min-h-11 shrink-0 items-center gap-1 border-b pr-[calc(var(--workspace-controls-right)+4.25rem)] pl-2 [-webkit-app-region:drag]",
          maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]">
          {attentionOpen && <AttentionTab />}
          {activityOpen && <ActivityTab />}
          {terminalOpen && <TerminalTab />}
          {itemSurfaces.map((surface) => {
            const id = surfaceId(surface);
            return <ItemTab key={id} surface={surface} />;
          })}
          <SurfaceCatalogMenu onSelect={(kind) => openSurface({ kind })} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {current.kind === "terminal" ? (
          <TerminalPanelBody />
        ) : (
          <CompactEngineGate.Provider>
            <CompactEngineGate.Live>
              {current.kind === "attention" && <AttentionPanelBody />}
              {current.kind === "activity" && <ActivityTabBody />}
              {current.kind === "item" && (
                <ItemPanelBody
                  key={`${surfaceId(current)}:${current.runId ?? ""}`}
                  workspace={current.workspace}
                  workItem={current.workItem}
                  runId={current.runId}
                  run={current.run}
                />
              )}
            </CompactEngineGate.Live>
            <CompactEngineGate.Connecting>
              <PanelSkeleton />
            </CompactEngineGate.Connecting>
            <CompactEngineGate.Off />
            <CompactEngineGate.Broken />
          </CompactEngineGate.Provider>
        )}
      </div>
    </div>
  );
}
