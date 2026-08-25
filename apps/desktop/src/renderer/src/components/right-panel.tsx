import { Skeleton } from "@cogwork/ui/components/skeleton";
import { cn } from "@cogwork/ui/lib/utils";
import type { ReactNode } from "react";
import { type RightPanelState, useRightPanelStore } from "../store/right-panel";
import { ActivitySurfaceBody, ActivitySurfaceTab } from "./activity-surface";
import { AttentionSurfaceBody, AttentionSurfaceTab } from "./attention-surface";
import { CompactEngineGate } from "./engine-gate";
import { ItemSurfaceTab, ItemTab } from "./item-tab";
import { SurfaceCatalogCards, SurfaceCatalogMenu } from "./surface-catalog";
import { SurfaceTab } from "./surface-tab";
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

function GatedBody({ children }: { children: ReactNode }) {
  return (
    <CompactEngineGate.Provider>
      <CompactEngineGate.Live>{children}</CompactEngineGate.Live>
      <CompactEngineGate.Connecting>
        <PanelSkeleton />
      </CompactEngineGate.Connecting>
      <CompactEngineGate.Off />
      <CompactEngineGate.Broken />
    </CompactEngineGate.Provider>
  );
}

type Surface = RightPanelState["surfaces"][number];

type SurfaceRenderers = {
  [K in Surface["kind"]]: (surface: Extract<Surface, { kind: K }>) => ReactNode;
};

const surfaceBodyByKind: SurfaceRenderers = {
  attention: () => (
    <GatedBody>
      <AttentionSurfaceBody />
    </GatedBody>
  ),
  activity: () => (
    <GatedBody>
      <ActivitySurfaceBody />
    </GatedBody>
  ),
  terminal: () => <TerminalSurfaceBody />,
  item: (surface) => (
    <GatedBody>
      <ItemTab key={`${surface.id}:${surface.runId ?? ""}`} selection={surface} />
    </GatedBody>
  ),
};

const surfaceTabByKind: SurfaceRenderers = {
  attention: () => <AttentionSurfaceTab />,
  activity: () => <ActivitySurfaceTab />,
  terminal: () => <TerminalSurfaceTab />,
  item: (surface) => <ItemSurfaceTab {...surface} />,
};

const surfaceBody = <K extends Surface["kind"]>(surface: Extract<Surface, { kind: K }>) =>
  surfaceBodyByKind[surface.kind](surface);

const surfaceTab = <K extends Surface["kind"]>(surface: Extract<Surface, { kind: K }>) =>
  surfaceTabByKind[surface.kind](surface);

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
          {surfaces.map((surface) => (
            <SurfaceTab.ContextMenu key={surface.id} id={surface.id}>
              {surfaceTab(surface)}
            </SurfaceTab.ContextMenu>
          ))}
          <SurfaceCatalogMenu />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{surfaceBody(current)}</div>
    </div>
  );
}
