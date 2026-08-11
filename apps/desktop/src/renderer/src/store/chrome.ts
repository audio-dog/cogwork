import type { WorkspaceId } from "@clanker-forge/contracts";
import { create } from "zustand";

interface ChromeState {
  readonly attentionCollapsed: boolean;
  readonly toggleAttention: () => void;
  readonly workspaceFilter: WorkspaceId | null;
  readonly setWorkspaceFilter: (workspace: WorkspaceId | null) => void;
}

export const useChromeStore = create<ChromeState>((set) => ({
  attentionCollapsed: false,
  toggleAttention: () => set((state) => ({ attentionCollapsed: !state.attentionCollapsed })),
  workspaceFilter: null,
  setWorkspaceFilter: (workspace) => set({ workspaceFilter: workspace }),
}));
