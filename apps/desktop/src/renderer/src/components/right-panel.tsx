import { Skeleton } from "@cogwork/ui/components/skeleton";
import { cn } from "@cogwork/ui/lib/utils";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComponentType, ReactNode } from "react";

import { type RightPanelState, useRightPanelStore } from "../store/right-panel";
import { ActivitySurfaceBody, ActivitySurfaceTab } from "./activity-surface";
import { AttentionSurfaceBody, AttentionSurfaceTab } from "./attention-surface";
import { CompactEngineGate } from "./engine-gate";
import { FileSurfaceBody, FileSurfaceTab } from "./file-surface";
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-center gap-3 px-4 py-6">
          <p className="text-sm text-muted-foreground">Choose what to show in the right panel.</p>
          <SurfaceCatalogCards />
        </div>
      </div>
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

/**
 * Component references, not thunks. Calling a component as a function folds its output into the
 * parent, so it gets no mount of its own — and switching surfaces could reuse the previous one's
 * state. Rendering `<Body />` gives each surface a real identity, hook scope and error boundary.
 */
type SurfaceComponents = {
  [K in Surface["kind"]]: ComponentType<{ surface: Extract<Surface, { kind: K }> }>;
};

const surfaceBodyByKind: SurfaceComponents = {
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
  // Not gated: a file is not a Run, so it does not wait on the engine.
  file: ({ surface }) => <FileSurfaceBody path={surface.path} />,
  item: ({ surface }) => (
    <GatedBody>
      <ItemTab key={`${surface.id}:${surface.runId ?? ""}`} selection={surface} />
    </GatedBody>
  ),
};

const surfaceTabByKind: SurfaceComponents = {
  attention: () => <AttentionSurfaceTab />,
  activity: () => <ActivitySurfaceTab />,
  terminal: () => <TerminalSurfaceTab />,
  file: ({ surface }) => <FileSurfaceTab id={surface.id} title={surface.title} />,
  item: ({ surface }) => <ItemSurfaceTab {...surface} />,
};

// One contained cast: TypeScript cannot narrow the map and the surface together on a lookup.
function SurfaceBody({ surface }: { surface: Surface }) {
  const Body = surfaceBodyByKind[surface.kind] as ComponentType<{ surface: Surface }>;
  return <Body surface={surface} />;
}

function SurfaceTabFor({ surface }: { surface: Surface }) {
  const Tab = surfaceTabByKind[surface.kind] as ComponentType<{ surface: Surface }>;
  return <Tab surface={surface} />;
}

function SortableSurfaceTab({ surface }: { surface: Surface }) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: surface.id,
    attributes: { role: "group", roleDescription: "sortable tab" },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn("flex shrink-0 items-center outline-none", isDragging && "z-10 opacity-70")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <SurfaceTab.ContextMenu id={surface.id}>
        <SurfaceTabFor surface={surface} />
      </SurfaceTab.ContextMenu>
    </div>
  );
}

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const reorderSurface = useRightPanelStore((state) => state.reorderSurface);
  const surfaceIds = surfaces.map((surface) => surface.id);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const current = surfaces.find((surface) => surface.id === active) ?? surfaces[0];

  const handleDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    const activeSurface = surfaces.find((surface) => surface.id === dragged.id);
    const overSurface = surfaces.find((surface) => surface.id === over?.id);
    if (!activeSurface || !overSurface) return;
    reorderSurface(activeSurface.id, overSurface.id);
  };

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
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            sensors={sensors}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
              {surfaces.map((surface) => (
                <SortableSurfaceTab key={surface.id} surface={surface} />
              ))}
            </SortableContext>
          </DndContext>
          <SurfaceCatalogMenu />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SurfaceBody surface={current} />
      </div>
    </div>
  );
}
