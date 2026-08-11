import { create } from "zustand";

interface ChromeState {
  readonly railCollapsed: boolean;
  readonly toggleRail: () => void;
}

export const useChromeStore = create<ChromeState>((set) => ({
  railCollapsed: false,
  toggleRail: () => set((state) => ({ railCollapsed: !state.railCollapsed })),
}));
