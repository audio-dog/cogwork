// PROTOTYPE — unsaved edits to the configuration surfaces, in memory only.
//
// A prototype persists nothing: persistence is the thing #126 already decided, not something this
// should depend on. The store lives outside the variants so edits survive a variant switch, which
// is what makes "the same change, seen three ways" judgeable.

import { create } from "zustand";
import { type DraftEntry, draftKey } from "../features/configuration-draft";
import type { DraftCell, ScopeRef } from "../features/configuration-model";

interface DraftState {
  readonly cells: Readonly<Record<string, DraftEntry>>;
  readonly setCell: (contributionId: string, scope: ScopeRef, cell: DraftCell) => void;
  readonly reset: () => void;
}

export const useConfigurationDraftStore = create<DraftState>((set) => ({
  cells: {},
  setCell: (contributionId, scope, cell) =>
    set((state) => ({
      cells: { ...state.cells, [draftKey(contributionId, scope)]: { scope, cell } },
    })),
  reset: () => set({ cells: {} }),
}));
