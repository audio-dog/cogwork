import { create } from "zustand";
import { type DraftEntry, draftKey } from "../features/configuration-draft";
import type { DraftCell, ScopeRef } from "../features/configuration-model";

interface DraftState {
  readonly cells: Readonly<Record<string, DraftEntry>>;
  readonly setCell: (contributionId: string, scope: ScopeRef, cell: DraftCell) => void;
}

export const useConfigurationDraftStore = create<DraftState>((set) => ({
  cells: {},
  setCell: (contributionId, scope, cell) =>
    set((state) => ({
      cells: { ...state.cells, [draftKey(contributionId, scope)]: { scope, cell } },
    })),
}));
