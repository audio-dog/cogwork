import { create } from "zustand";

export type SurfaceKind = "attention" | "detail" | "activity";

export const SURFACE_ORDER: readonly SurfaceKind[] = ["attention", "detail", "activity"];

export interface RightPanelState {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly surfaces: readonly SurfaceKind[];
  readonly active: SurfaceKind | null;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly togglePanel: () => void;
  readonly openSurface: (kind: SurfaceKind) => void;
  readonly closeSurface: (kind: SurfaceKind) => void;
  readonly setActive: (kind: SurfaceKind) => void;
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
  openSurface: (kind) =>
    set((state) => ({
      open: true,
      active: kind,
      surfaces: state.surfaces.includes(kind) ? state.surfaces : [...state.surfaces, kind],
    })),
  closeSurface: (kind) =>
    set((state) => {
      const surfaces = state.surfaces.filter((surface) => surface !== kind);
      const active = state.active === kind ? (surfaces[surfaces.length - 1] ?? null) : state.active;
      return { surfaces, active };
    }),
  setActive: (kind) => set({ active: kind }),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
}));
