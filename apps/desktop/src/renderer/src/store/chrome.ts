import type { WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { create } from "zustand";

export interface ItemSelection {
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
}

interface ChromeState {
  readonly workspaceFilter: WorkspaceId | null;
  readonly setWorkspaceFilter: (workspace: WorkspaceId | null) => void;
}

export const useChromeStore = create<ChromeState>((set) => ({
  workspaceFilter: null,
  setWorkspaceFilter: (workspace) => set({ workspaceFilter: workspace }),
}));
