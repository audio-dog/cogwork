import { create } from "zustand";
import { persist } from "zustand/middleware";

// TODO(desktop preferences seam): local-only and drives nothing in the engine yet — there is no
// config-write RPC for scheduler limits or budget (checked in #44). `null` means "not edited
// locally, follow the daemon-seeded value". When the persistence seam lands (follow-up ticket),
// write these through it and seed from it instead of holding them here.
export interface EnginePreferences {
  readonly globalLimit: number | null;
  readonly perWorkspaceLimit: number | null;
  readonly dailyBudget: number | null;
  readonly setGlobalLimit: (value: number) => void;
  readonly setPerWorkspaceLimit: (value: number) => void;
  readonly setDailyBudget: (value: number) => void;
}

export const useEnginePreferences = create<EnginePreferences>()(
  persist(
    (set) => ({
      globalLimit: null,
      perWorkspaceLimit: null,
      dailyBudget: null,
      setGlobalLimit: (globalLimit) => set({ globalLimit }),
      setPerWorkspaceLimit: (perWorkspaceLimit) => set({ perWorkspaceLimit }),
      setDailyBudget: (dailyBudget) => set({ dailyBudget }),
    }),
    { name: "cogwork.enginePreferences" },
  ),
);
