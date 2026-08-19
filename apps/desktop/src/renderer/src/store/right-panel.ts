import type { WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

// A side-panel tab. Attention and Activity are fixed singletons; an item tab is
// identified by the (workspace, work item) pair it drills into.
export type Surface =
  | { readonly kind: "attention" }
  | { readonly kind: "activity" }
  | { readonly kind: "item"; readonly workspace: WorkspaceId; readonly workItem: WorkItemId };

export type SurfaceId = string;

export function surfaceId(surface: Surface): SurfaceId {
  return surface.kind === "item" ? `item:${surface.workspace}:${surface.workItem}` : surface.kind;
}

// The fixed tabs are always present and cannot be closed. Item tabs are appended
// after them in the order they were opened.
export const FIXED_SURFACES: readonly Surface[] = [{ kind: "attention" }, { kind: "activity" }];

const DEFAULT_ACTIVE = surfaceId({ kind: "attention" });

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
      const exists = state.surfaces.some((entry) => surfaceId(entry) === id);
      return {
        open: true,
        active: id,
        surfaces: exists ? state.surfaces : [...state.surfaces, surface],
      };
    }),
  closeSurface: (id) =>
    set((state) => {
      const target = state.surfaces.find((entry) => surfaceId(entry) === id);
      if (target?.kind !== "item") return state;
      const surfaces = state.surfaces.filter((entry) => surfaceId(entry) !== id);
      const fallback = surfaces[surfaces.length - 1];
      const active = state.active === id && fallback ? surfaceId(fallback) : state.active;
      return { surfaces, active };
    }),
  setActive: (id) => set({ active: id }),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
}));
