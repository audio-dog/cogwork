import type { DaemonEvent } from "@clanker-forge/contracts";
import { Button } from "@clanker-forge/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@clanker-forge/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { cn } from "@clanker-forge/ui/lib/utils";
import {
  RiAddLine,
  RiCloseLine,
  RiCollapseDiagonalLine,
  RiExpandDiagonalLine,
  RiFileList2Line,
  RiFocus2Line,
  RiPulseLine,
} from "@remixicon/react";
import type { ComponentType, ReactNode } from "react";
import { useLiveEvents } from "../features/use-live-events";
import { useChromeStore } from "../store/chrome";
import { SURFACE_ORDER, type SurfaceKind, useRightPanelStore } from "../store/right-panel";
import { AttentionList } from "./attention-rail";
import { ItemDetail } from "./item-detail";

interface SurfaceMeta {
  readonly label: string;
  readonly description: string;
  readonly icon: ComponentType<{ className?: string }>;
}

const SURFACE_META: Record<SurfaceKind, SurfaceMeta> = {
  attention: {
    label: "Attention",
    description: "Self-halts and PRs waiting at the merge gate.",
    icon: RiFocus2Line,
  },
  detail: {
    label: "Detail",
    description: "Drill into the selected item's run and gates.",
    icon: RiFileList2Line,
  },
  activity: {
    label: "Activity",
    description: "The raw daemon event stream, live.",
    icon: RiPulseLine,
  },
};

function SurfaceFill({ children }: { children: ReactNode }) {
  return (
    <div className="size-full [&>aside]:size-full [&>aside]:w-full [&>aside]:border-l-0">{children}</div>
  );
}

function DetailSurface() {
  const selection = useChromeStore((state) => state.selection);
  if (!selection) {
    return (
      <div className="grid size-full place-items-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No item selected</EmptyTitle>
            <EmptyDescription>Pick an item from the Feed or the Attention tab.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <SurfaceFill>
      <ItemDetail selection={selection} />
    </SurfaceFill>
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

function ActivitySurface() {
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

function SurfaceBody({ kind }: { kind: SurfaceKind }) {
  switch (kind) {
    case "attention":
      return (
        <SurfaceFill>
          <AttentionList />
        </SurfaceFill>
      );
    case "detail":
      return <DetailSurface />;
    case "activity":
      return <ActivitySurface />;
  }
}

function OpenASurface() {
  const openSurface = useRightPanelStore((state) => state.openSurface);
  return (
    <div className="flex size-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        <div className="mb-4 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">Choose what to show in the side panel.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {SURFACE_ORDER.map((kind) => {
            const meta = SURFACE_META[kind];
            const Icon = meta.icon;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => openSurface(kind)}
                className="relative flex w-full cursor-pointer flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60"
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0" />
                  <span className="text-sm font-medium">{meta.label}</span>
                </span>
                <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {meta.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AddSurfaceMenu() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const openSurface = useRightPanelStore((state) => state.openSurface);
  const closed = SURFACE_ORDER.filter((kind) => !surfaces.includes(kind));
  if (closed.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button aria-label="Add a surface" size="icon-sm" variant="ghost">
            <RiAddLine />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {closed.map((kind) => {
          const meta = SURFACE_META[kind];
          const Icon = meta.icon;
          return (
            <DropdownMenuItem key={kind} onClick={() => openSurface(kind)}>
              <Icon />
              {meta.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SurfaceTab({ kind }: { kind: SurfaceKind }) {
  const active = useRightPanelStore((state) => state.active);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const meta = SURFACE_META[kind];
  const Icon = meta.icon;
  const isActive = kind === active;
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-2 text-xs",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-1.5"
        onClick={() => setActive(kind)}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{meta.label}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${meta.label}`}
        className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm hover:bg-muted"
        onClick={() => closeSurface(kind)}
      >
        <RiCloseLine className="size-3" />
      </button>
    </div>
  );
}

export function RightPanel() {
  const surfaces = useRightPanelStore((state) => state.surfaces);
  const active = useRightPanelStore((state) => state.active);
  const maximized = useRightPanelStore((state) => state.maximized);
  const closePanel = useRightPanelStore((state) => state.closePanel);
  const toggleMaximized = useRightPanelStore((state) => state.toggleMaximized);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-11 min-h-11 shrink-0 items-center gap-1 border-b pr-2 pl-2 [-webkit-app-region:drag]",
          // Maximized over a collapsed sidebar, inset the strip to clear the fixed toggle.
          maximized && "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
          {surfaces.map((kind) => (
            <SurfaceTab key={kind} kind={kind} />
          ))}
          <AddSurfaceMenu />
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
        {active ? <SurfaceBody kind={active} /> : <OpenASurface />}
      </div>
    </div>
  );
}
