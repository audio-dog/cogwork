import { Skeleton } from "@cogwork/ui/components/skeleton";
import { cn } from "@cogwork/ui/lib/utils";
import { type RightPanelState, useRightPanelStore } from "../store/right-panel";
import { ActivitySurfaceBody, ActivitySurfaceTab } from "./activity-surface";
import { AttentionSurfaceBody, AttentionSurfaceTab } from "./attention-surface";
import { CompactEngineGate } from "./engine-gate";
import { ItemSurfaceTab, ItemTab } from "./item-tab";
import { SurfaceCatalogCards, SurfaceCatalogMenu } from "./surface-catalog";
import { TerminalSurfaceBody, TerminalSurfaceTab } from "./terminal-surface";

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptySurfaceCatalog() {
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
        </div>
      </div>
      <p className="px-4 pt-3 text-sm text-muted-foreground">Choose what to show in the right panel.</p>
      <SurfaceCatalogCards />
    </div>
  );
}

function ActiveSurfaceBody({ surface }: { surface: RightPanelState["surfaces"][number] }) {
  switch (surface.kind) {
    case "attention":
      return (
        <CompactEngineGate.Provider>
          <CompactEngineGate.Live>
            <AttentionSurfaceBody />
          </CompactEngineGate.Live>
          <CompactEngineGate.Connecting>
            <PanelSkeleton />
          </CompactEngineGate.Connecting>
          <CompactEngineGate.Off />
          <CompactEngineGate.Broken />
        </CompactEngineGate.Provider>
      );
    case "activity":
      return (
        <CompactEngineGate.Provider>
          <CompactEngineGate.Live>
            <ActivitySurfaceBody />
          </CompactEngineGate.Live>
          <CompactEngineGate.Connecting>
            <PanelSkeleton />
          </CompactEngineGate.Connecting>
          <CompactEngineGate.Off />
          <CompactEngineGate.Broken />
        </CompactEngineGate.Provider>
      );
    case "terminal":
      return <TerminalSurfaceBody />;
    case "item":
      return (
        <CompactEngineGate.Provider>
          <CompactEngineGate.Live>
            <ItemTab key={`${surface.id}:${surface.runId ?? ""}`} selection={surface} />
          </CompactEngineGate.Live>
          <CompactEngineGate.Connecting>
            <PanelSkeleton />
          </CompactEngineGate.Connecting>
          <CompactEngineGate.Off />
          <CompactEngineGate.Broken />
        </CompactEngineGate.Provider>
      );
  }
}

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const current = surfaces.find((surface) => surface.id === active) ?? surfaces[0];

  if (!current) return <EmptySurfaceCatalog />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-11 min-h-11 shrink-0 items-center gap-1 border-b pr-[calc(var(--workspace-controls-right)+4.25rem)] pl-2 [-webkit-app-region:drag]",
          maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]">
          {surfaces.map((surface) => {
            switch (surface.kind) {
              case "attention":
                return <AttentionSurfaceTab key={surface.id} />;
              case "activity":
                return <ActivitySurfaceTab key={surface.id} />;
              case "terminal":
                return <TerminalSurfaceTab key={surface.id} />;
              case "item":
                return <ItemSurfaceTab key={surface.id} {...surface} />;
              default:
                return null;
            }
          })}
          <SurfaceCatalogMenu />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ActiveSurfaceBody surface={current} />
      </div>
    </div>
  );
}
