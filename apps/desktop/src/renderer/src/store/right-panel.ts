import type { RunId, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

export type Surface =
  | { readonly kind: "attention" }
  | { readonly kind: "activity" }
  | { readonly kind: "terminal" }
  | {
      readonly kind: "item";
      readonly workspace: WorkspaceId;
      readonly workItem: WorkItemId;
      readonly runId?: RunId;
      readonly run?: RunSummary;
    };

export type SurfaceId = string;

export function surfaceId(surface: Surface): SurfaceId {
  return surface.kind === "item" ? `item:${surface.workspace}:${surface.workItem}` : surface.kind;
}

function updatedSurface(existing: Surface, next: Surface) {
  if (existing.kind === "item" && next.kind === "item" && existing.runId && !next.runId) {
    return existing;
  }
  return next;
}

function upsertSurface(surfaces: readonly Surface[], next: Surface) {
  const id = surfaceId(next);
  const existing = surfaces.findIndex((surface) => surfaceId(surface) === id);

  if (existing === -1) return [...surfaces, next];

  return surfaces.map((surface, index) => (index === existing ? updatedSurface(surface, next) : surface));
}

function fallbackActiveSurfaceId(
  surfaces: readonly Surface[],
  closingId: SurfaceId,
  active: SurfaceId | null,
) {
  if (active !== closingId) return active;
  const fallback = surfaces[surfaces.length - 1];
  return fallback ? surfaceId(fallback) : null;
}

export interface RightPanelState {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly surfaces: readonly Surface[];
  readonly active: SurfaceId | null;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly togglePanel: () => void;
  readonly openSurface: (surface: Surface) => void;
  readonly closeSurface: (id: SurfaceId) => void;
  readonly closeOtherSurfaces: (id: SurfaceId) => void;
  readonly closeAllSurfaces: () => void;
  readonly setActive: (id: SurfaceId) => void;
  readonly toggleMaximized: () => void;
}

export const useRightPanelStore = create<RightPanelState>((set) => ({
  open: false,
  maximized: false,
  surfaces: [],
  active: null,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false, maximized: false }),
  togglePanel: () => set((state) => ({ open: !state.open, maximized: false })),
  openSurface: (surface) =>
    set((state) => {
      const id = surfaceId(surface);
      return {
        open: true,
        active: id,
        surfaces: upsertSurface(state.surfaces, surface),
      };
    }),
  closeSurface: (id) =>
    set((state) => {
      const surfaces = state.surfaces.filter((entry) => surfaceId(entry) !== id);
      if (surfaces.length === state.surfaces.length) return state;
      return { surfaces, active: fallbackActiveSurfaceId(surfaces, id, state.active) };
    }),
  closeOtherSurfaces: (id) =>
    set((state) => {
      const surface = state.surfaces.find((entry) => surfaceId(entry) === id);
      if (!surface) return state;
      return { surfaces: [surface], active: id };
    }),
  closeAllSurfaces: () => set({ surfaces: [], active: null }),
  setActive: (id) =>
    set((state) => (state.surfaces.some((surface) => surfaceId(surface) === id) ? { active: id } : state)),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
}));
