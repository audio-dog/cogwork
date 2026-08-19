import { create } from "zustand";
import { persist } from "zustand/middleware";

// TODO(desktop preferences seam): closeToHide is persisted locally only and drives nothing yet —
// there is no typed IPC seam for window prefs. When that seam lands, write through it and seed from it.
export interface DesktopPreferences {
  readonly closeToHide: boolean;
  readonly setCloseToHide: (value: boolean) => void;
}

export const useDesktopPreferences = create<DesktopPreferences>()(
  persist(
    (set) => ({
      closeToHide: true,
      setCloseToHide: (closeToHide) => set({ closeToHide }),
    }),
    { name: "cogwork.desktopPreferences" },
  ),
);
