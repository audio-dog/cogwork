import type { DaemonEvent, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
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
import { useLiveEvents } from "../features/use-live-events";
import { type Surface, type SurfaceId, surfaceId, useRightPanelStore } from "../store/right-panel";
import { AttentionList } from "./attention-rail";
import { ItemDetail } from "./item-detail";

function SurfaceFill({ children }: { children: React.ReactNode }) {
  return (
    <div className="size-full [&>aside]:size-full [&>aside]:w-full [&>aside]:border-l-0">{children}</div>
  );
}

function describeLiveEvent(event: DaemonEvent): string {
  switch (event._tag) {
    case "RunActivity":
      return `run ${event.activity.runId} · #${event.activity.seq}`;
    case "ItemChanged":
      return `${event.workspace} · ${event.item.id}`;
    case "RunChanged":
      return `run ${event.run.id} → ${event.run.status}`;
    case "SchedulerChanged":
      return `${event.scheduler.globalInFlight} / ${event.scheduler.globalLimit} in flight`;
    default:
      return event._tag;
  }
}

function ActivityPanelBody() {
  const result = useLiveEvents();
  if (result._tag !== "Success") {
    return <p className="p-4 text-xs text-muted-foreground">Waiting for daemon events…</p>;
  }
  const { items } = result.value;
  const start = Math.max(0, items.length - 40);
  const recent = items.slice(start);
  if (recent.length === 0) {
    return <p className="p-4 text-xs text-muted-foreground">No events yet this session.</p>;
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-3 text-xs">
      {recent
        .map((event, offset) => (
          <li key={start + offset} className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{event._tag}</span>
            <span className="truncate text-muted-foreground">{describeLiveEvent(event)}</span>
          </li>
        ))
        .reverse()}
    </ul>
  );
}

function AttentionPanelBody() {
  return (
    <SurfaceFill>
      <AttentionList />
    </SurfaceFill>
  );
}

function ItemPanelBody({ workspace, workItem }: { workspace: WorkspaceId; workItem: WorkItemId }) {
  return (
    <SurfaceFill>
      <ItemDetail selection={{ workspace, workItem }} />
    </SurfaceFill>
  );
}

function AttentionTab({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-2 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button type="button" className="flex min-w-0 cursor-pointer items-center gap-1.5" onClick={onSelect}>
        <RiFocus2Line className="size-3.5 shrink-0" />
        <span className="truncate">Attention</span>
      </button>
    </div>
  );
}

function ActivityTab({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-2 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button type="button" className="flex min-w-0 cursor-pointer items-center gap-1.5" onClick={onSelect}>
        <RiPulseLine className="size-3.5 shrink-0" />
        <span className="truncate">Activity</span>
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
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-2 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
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

function activeSurface(surfaces: readonly Surface[], active: SurfaceId): Surface {
  return surfaces.find((surface) => surfaceId(surface) === active) ?? surfaces[0];
}

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const closePanel = useRightPanelStore((state) => state.closePanel);
  const toggleMaximized = useRightPanelStore((state) => state.toggleMaximized);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const current = activeSurface(surfaces, active);
  const itemSurfaces = surfaces.filter(
    (surface): surface is Extract<Surface, { kind: "item" }> => surface.kind === "item",
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-11 min-h-11 shrink-0 items-center gap-1 border-b pr-2 pl-2 [-webkit-app-region:drag]",
          // Maximized over a collapsed sidebar, inset the strip to clear the fixed toggle.
          maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]">
          <AttentionTab active={active === "attention"} onSelect={() => setActive("attention")} />
          <ActivityTab active={active === "activity"} onSelect={() => setActive("activity")} />
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
        {current.kind === "attention" && <AttentionPanelBody />}
        {current.kind === "activity" && <ActivityPanelBody />}
        {current.kind === "item" && (
          <ItemPanelBody workspace={current.workspace} workItem={current.workItem} />
        )}
      </div>
    </div>
  );
}
