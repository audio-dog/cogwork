import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { HarnessAlert } from "../features/harness-alerts";

interface HarnessAlertState {
  readonly dismissed: Readonly<Record<string, string>>;
  readonly dismiss: (alert: HarnessAlert) => void;
}

export const useHarnessAlertStore = create<HarnessAlertState>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: ({ harness, key }) => set((state) => ({ dismissed: { ...state.dismissed, [harness]: key } })),
    }),
    { name: "harness-alerts", partialize: ({ dismissed }) => ({ dismissed }) },
  ),
);
