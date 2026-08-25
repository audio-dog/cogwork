// PROTOTYPE — which workspace the Customize page is looking at.
//
// Lives outside the variants so the selection survives a variant switch: comparing three filter
// designs is only fair if all three are pointed at the same thing.

import { create } from "zustand";
import type { WorkspaceId } from "../features/configuration-model";
import { cogworkWorkspaceId } from "../features/configuration-placeholder";

interface CustomizeViewState {
  readonly workspaceId: WorkspaceId;
  readonly setWorkspaceId: (workspaceId: WorkspaceId) => void;
}

export const useCustomizeViewStore = create<CustomizeViewState>((set) => ({
  workspaceId: cogworkWorkspaceId,
  setWorkspaceId: (workspaceId) => set({ workspaceId }),
}));
