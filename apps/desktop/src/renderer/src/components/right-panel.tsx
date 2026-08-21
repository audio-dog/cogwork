import type { RunId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiCloseLine,
  RiCollapseDiagonalLine,
  RiExpandDiagonalLine,
  RiFileList2Line,
  RiFocus2Line,
  RiPulseLine,
} from "@remixicon/react";
import { type Surface, type SurfaceId, surfaceId, useRightPanelStore } from "../store/right-panel";
import { ActivityTab as ActivityTabBody } from "./activity-tab";
import { ActivityViewProvider } from "./activity-view";
import { AttentionList } from "./attention-rail";
import { CompactEngineGate } from "./engine-gate";
import { ItemTab as ItemTabView } from "./item-tab";

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
}: {
  workspace: WorkspaceId;
  workItem: WorkItemId;
  runId?: RunId;
}) {
  return <ItemTabView selection={{ workspace, workItem, runId }} />;
}

function tabClassName(active: boolean, padding: string) {
  return cn(baseTabClassName, padding, active ? activeTabClassName : inactiveTabClassName);
}

function FixedTab({
  active,
  onSelect,
  icon,
  label,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className={tabClassName(active, "px-2")}>
      <button type="button" className="flex min-w-0 cursor-pointer items-center gap-1.5" onClick={onSelect}>
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

function ItemTab({
  workspace,
  workItem,
  active,
  onSelect,
  onClose,
}: {
  workspace: WorkspaceId;
  workItem: WorkItemId;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div className={tabClassName(active, "pl-2 pr-1")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-center gap-1.5"
              onClick={onSelect}
            >
              <RiFileList2Line className="size-3.5 shrink-0" />
              <span className="truncate">{workItem}</span>
            </button>
          }
        />
        <TooltipContent side="bottom">{workspace}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={`Close ${workItem}`}
        className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm hover:bg-muted"
        onClick={onClose}
      >
        <RiCloseLine className="size-3" />
      </button>
    </div>
  );
}

function currentSurface(surfaces: readonly Surface[], active: SurfaceId): Surface {
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

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const closePanel = useRightPanelStore((state) => state.closePanel);
  const toggleMaximized = useRightPanelStore((state) => state.toggleMaximized);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const current = currentSurface(surfaces, active);
  const itemSurfaces = surfaces.filter(
    (surface): surface is Extract<Surface, { kind: "item" }> => surface.kind === "item",
  );

  return (
    <ActivityViewProvider>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div
          className={cn(
            "flex h-11 min-h-11 shrink-0 items-center gap-1 border-b pr-2 pl-2 [-webkit-app-region:drag]",
            maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]">
            <FixedTab
              active={active === "attention"}
              onSelect={() => setActive("attention")}
              icon={<RiFocus2Line className="size-3.5 shrink-0" />}
              label="Attention"
            />
            <FixedTab
              active={active === "activity"}
              onSelect={() => setActive("activity")}
              icon={<RiPulseLine className="size-3.5 shrink-0" />}
              label="Activity"
            />
            {itemSurfaces.map((surface) => {
              const id = surfaceId(surface);
              return (
                <ItemTab
                  key={id}
                  workspace={surface.workspace}
                  workItem={surface.workItem}
                  active={active === id}
                  onSelect={() => setActive(id)}
                  onClose={() => closeSurface(id)}
                />
              );
            })}
          </div>
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <Button
              aria-label={maximized ? "Restore panel" : "Expand panel"}
              size="icon-sm"
              variant="ghost"
              onClick={toggleMaximized}
            >
              {maximized ? <RiCollapseDiagonalLine /> : <RiExpandDiagonalLine />}
            </Button>
            <Button aria-label="Close panel" size="icon-sm" variant="ghost" onClick={closePanel}>
              <RiCloseLine />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
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
                />
              )}
            </CompactEngineGate.Live>
            <CompactEngineGate.Connecting>
              <PanelSkeleton />
            </CompactEngineGate.Connecting>
            <CompactEngineGate.Off />
            <CompactEngineGate.Broken />
          </CompactEngineGate.Provider>
        </div>
      </div>
    </ActivityViewProvider>
  );
}
