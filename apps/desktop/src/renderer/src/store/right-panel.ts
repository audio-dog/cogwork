import type { RunId, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

type ToolKind = "attention" | "activity" | "terminal";

type ToolSurface = { readonly id: ToolKind; readonly kind: ToolKind };

type ItemSurface = {
  readonly id: `item:${string}:${string}`;
  readonly kind: "item";
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
  readonly runId?: RunId;
  readonly run?: RunSummary;
};

type Surface = ToolSurface | ItemSurface;

type SurfaceId = Surface["id"];

const itemSurfaceId = (workspace: WorkspaceId, workItem: WorkItemId) =>
  `item:${workspace}:${workItem}` as const;

const runFields = (run?: RunId | RunSummary) => {
  if (!run) return {};
  if (typeof run === "string") return { runId: run };
  return { runId: run.id, run };
};

const itemSurface = (
  workspace: WorkspaceId,
  workItem: WorkItemId,
  run?: RunId | RunSummary,
): ItemSurface => ({
  id: itemSurfaceId(workspace, workItem),
  kind: "item",
  workspace,
  workItem,
  ...runFields(run),
});

const upsertSurface = (surfaces: readonly Surface[], next: Surface) => {
  const existing = surfaces.findIndex((surface) => surface.id === next.id);
  if (existing === -1) return [...surfaces, next];
  return surfaces.map((surface, index) => (index === existing ? next : surface));
};

const fallbackActiveSurfaceId = (
  surfaces: readonly Surface[],
  closingId: SurfaceId,
  active: SurfaceId | null,
) => {
  if (active !== closingId) return active;
  return surfaces.at(-1)?.id ?? null;
};

export interface RightPanelState {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly surfaces: readonly Surface[];
  readonly active: SurfaceId | null;
  readonly togglePanel: () => void;
  readonly openItem: (workspace: WorkspaceId, workItem: WorkItemId, run?: RunId | RunSummary) => void;
  readonly openTool: (kind: ToolKind) => void;
  readonly closeSurface: (id: SurfaceId) => void;
  readonly closeOtherSurfaces: (id: SurfaceId) => void;
  readonly closeAllSurfaces: () => void;
  readonly setActive: (id: SurfaceId) => void;
  readonly toggleMaximized: () => void;
}

const open = (surfaces: readonly Surface[], next: Surface) => ({
  open: true,
  active: next.id,
  surfaces: upsertSurface(surfaces, next),
});

export const useRightPanelStore = create<RightPanelState>((set) => ({
  open: false,
  maximized: false,
  surfaces: [],
  active: null,
  togglePanel: () => set((state) => ({ open: !state.open, maximized: false })),
  openItem: (workspace, workItem, run) =>
    set((state) => open(state.surfaces, itemSurface(workspace, workItem, run))),
  openTool: (kind) => set((state) => open(state.surfaces, { id: kind, kind })),
  closeSurface: (id) =>
    set((state) => {
      const surfaces = state.surfaces.filter((surface) => surface.id !== id);
      if (surfaces.length === state.surfaces.length) return state;
      return { surfaces, active: fallbackActiveSurfaceId(surfaces, id, state.active) };
    }),
  closeOtherSurfaces: (id) =>
    set((state) => {
      const surface = state.surfaces.find((entry) => entry.id === id);
      if (!surface) return state;
      return { surfaces: [surface], active: id };
    }),
  closeAllSurfaces: () => set({ surfaces: [], active: null }),
  setActive: (id) =>
    set((state) => (state.surfaces.some((surface) => surface.id === id) ? { active: id } : state)),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
}));
