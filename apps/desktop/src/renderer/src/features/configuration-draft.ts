// PROTOTYPE — applies unsaved edits over the rows the daemon sent.
//
// Kept separate from the store so it stays a pure function the tests can call, and separate from
// the resolver so the resolver keeps modelling only what #133 actually specifies.

import { type Contribution, type DraftCell, type ScopeRef, sameScope, scopeKey } from "./configuration-model";

export interface DraftEntry {
  readonly scope: ScopeRef;
  readonly cell: DraftCell;
}

export function draftKey(contributionId: string, scope: ScopeRef): string {
  return `${contributionId}|${scopeKey(scope)}`;
}

/**
 * `unset` removes the row rather than writing `false`, because absence is not a third value — a
 * Scope that says nothing shadows nothing. This is the whole reason a two-state switch is wrong.
 */
export function withDraft(
  contribution: Contribution,
  cells: Readonly<Record<string, DraftEntry>>,
): Contribution {
  const edits = Object.entries(cells)
    .filter(([key]) => key.startsWith(`${contribution.id}|`))
    .map(([, entry]) => entry);

  if (edits.length === 0) return contribution;

  const untouched = contribution.rows.filter(
    (row) => !edits.some((edit) => sameScope(edit.scope, row.scope)),
  );
  const written = edits
    .filter((edit) => edit.cell !== "unset")
    .map((edit) => ({
      scope: edit.scope,
      value: edit.cell === "on",
      source: "unsaved edit",
    }));

  return { ...contribution, rows: [...untouched, ...written] };
}

/** What a single cell currently holds, draft included. */
export function draftCellAt(
  contribution: Contribution,
  scope: ScopeRef,
  cells: Readonly<Record<string, DraftEntry>>,
): DraftCell {
  const edit = cells[draftKey(contribution.id, scope)];
  if (edit) return edit.cell;
  const row = contribution.rows.find((candidate) => sameScope(candidate.scope, scope));
  if (row === undefined) return "unset";
  return row.value ? "on" : "off";
}
