import { type Contribution, type DraftCell, type ScopeRef, sameScope, scopeKey } from "./configuration-model";

export interface DraftEntry {
  readonly scope: ScopeRef;
  readonly cell: DraftCell;
}

export function draftKey(contributionId: string, scope: ScopeRef): string {
  return `${contributionId}|${scopeKey(scope)}`;
}

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
