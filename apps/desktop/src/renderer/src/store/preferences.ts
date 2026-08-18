import { create } from "zustand";
import { persist } from "zustand/middleware";

// TODO(#7 desktop preferences persistence seam): these persist locally only. Close-to-hide is
// main-side window behavior and the scheduler limits + daily budget are daemon-owned (read-only in
// SchedulerStats; the only write RPC, SetScheduling, just toggles running/paused), so nothing here
// drives the window or engine yet. When the seam lands, write through it and seed from the real
// source. Theme is already real — it lives in ThemeProvider, not here.
export interface DesktopPreferences {
  readonly closeToHide: boolean;
  readonly schedulerGlobalLimit: number;
  readonly schedulerPerWorkspaceLimit: number;
  readonly dailyBudget: number;
  readonly setCloseToHide: (value: boolean) => void;
  readonly setSchedulerGlobalLimit: (value: number) => void;
  readonly setSchedulerPerWorkspaceLimit: (value: number) => void;
  readonly setDailyBudget: (value: number) => void;
}

export const useDesktopPreferences = create<DesktopPreferences>()(
  persist(
    (set) => ({
      closeToHide: true,
      schedulerGlobalLimit: 3,
      schedulerPerWorkspaceLimit: 1,
      dailyBudget: 25,
      setCloseToHide: (closeToHide) => set({ closeToHide }),
      setSchedulerGlobalLimit: (schedulerGlobalLimit) => set({ schedulerGlobalLimit }),
      setSchedulerPerWorkspaceLimit: (schedulerPerWorkspaceLimit) => set({ schedulerPerWorkspaceLimit }),
      setDailyBudget: (dailyBudget) => set({ dailyBudget }),
    }),
    { name: "cogwork.desktopPreferences" },
  ),
);
