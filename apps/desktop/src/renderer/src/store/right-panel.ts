import type { RunId, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

export type Surface =
  | { readonly kind: "attention" }
  | { readonly kind: "activity" }
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

export const FIXED_SURFACES: readonly Surface[] = [{ kind: "attention" }, { kind: "activity" }];

const DEFAULT_ACTIVE = surfaceId({ kind: "attention" });

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

function fallbackActiveSurfaceId(surfaces: readonly Surface[], closingId: SurfaceId, active: SurfaceId) {
  if (active !== closingId) return active;
  return surfaceId(surfaces[surfaces.length - 1] ?? FIXED_SURFACES[0]);
}

export interface RightPanelState {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly surfaces: readonly Surface[];
  readonly active: SurfaceId;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly togglePanel: () => void;
  readonly openSurface: (surface: Surface) => void;
  readonly closeSurface: (id: SurfaceId) => void;
  readonly setActive: (id: SurfaceId) => void;
  readonly toggleMaximized: () => void;
}

export const useRightPanelStore = create<RightPanelState>((set) => ({
  open: false,
  maximized: false,
  surfaces: FIXED_SURFACES,
  active: DEFAULT_ACTIVE,
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
      const target = state.surfaces.find((entry) => surfaceId(entry) === id);
      if (target?.kind !== "item") return state;
      const surfaces = state.surfaces.filter((entry) => surfaceId(entry) !== id);
      return { surfaces, active: fallbackActiveSurfaceId(surfaces, id, state.active) };
    }),
  setActive: (id) => set({ active: id }),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
}));
