import type { WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

export interface ItemSelection {
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
}

interface ChromeState {
  readonly attentionCollapsed: boolean;
  readonly toggleAttention: () => void;
  readonly workspaceFilter: WorkspaceId | null;
  readonly setWorkspaceFilter: (workspace: WorkspaceId | null) => void;
  readonly selection: ItemSelection | null;
  readonly select: (selection: ItemSelection) => void;
  readonly clearSelection: () => void;
}

export const useChromeStore = create<ChromeState>((set) => ({
  attentionCollapsed: false,
  toggleAttention: () => set((state) => ({ attentionCollapsed: !state.attentionCollapsed })),
  workspaceFilter: null,
  setWorkspaceFilter: (workspace) => set({ workspaceFilter: workspace }),
  selection: null,
  select: (selection) => set({ selection, attentionCollapsed: false }),
  clearSelection: () => set({ selection: null }),
}));
