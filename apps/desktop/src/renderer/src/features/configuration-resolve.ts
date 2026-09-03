import {
  type Contribution,
  type ContributionKind,
  Diagnostic,
  type EnablementRow,
  enablementScopes,
  type ScopeKind,
  type ScopeRef,
  scopeOrder,
  type WorkspaceId,
} from "./configuration-model";

export interface ViewContext {
  readonly workspaceId?: WorkspaceId;
}

function scopeRank(kind: ScopeKind): number {
  return scopeOrder.indexOf(kind);
}

function inView(row: { readonly scope: ScopeRef }, view: ViewContext): boolean {
  if (row.scope.workspaceId === undefined) return true;
  return row.scope.workspaceId === view.workspaceId;
}

function admissibleFor(kind: ContributionKind, row: EnablementRow): boolean {
  return enablementScopes[kind].includes(row.scope.kind);
}

export interface DroppedRow {
  readonly row: EnablementRow;
  readonly diagnostic: Diagnostic;
}

export interface ResolvedEnablement {
  readonly effective?: boolean;
  readonly stored?: EnablementRow;
  readonly winner?: EnablementRow;
  readonly shadowed: readonly EnablementRow[];
  readonly dropped: readonly DroppedRow[];
}

/**
 * A diagnostic is a fact about the Contribution's own settings, not about what you are looking at.
 * A machine-level Contribution has no `definedIn`, so every view that names a workspace would drop
 * its overlay rows — and with them the reason those rows are broken. Report diagnostics for every
 * row, and let only the effective value depend on the view.
 */
export function diagnosticsOf(contribution: Contribution): readonly DroppedRow[] {
  return contribution.rows
    .filter((row) => row.diagnostic !== undefined || !admissibleFor(contribution.kind, row))
    .map((row) => ({
      row,
      diagnostic:
        row.diagnostic ??
        Diagnostic.inadmissible({
          detail: `A ${contribution.kind} on / off may not be written at the ${row.scope.kind} Scope.`,
          source: row.source,
        }),
    }));
}

export function resolveEnablement(contribution: Contribution, view: ViewContext): ResolvedEnablement {
  const visible = contribution.rows.filter((row) => inView(row, view));
  const dropped = diagnosticsOf(contribution).filter((entry) => inView(entry.row, view));

  const droppedRows = new Set(dropped.map((entry) => entry.row));
  const storedRows = visible
    .filter((row) => admissibleFor(contribution.kind, row))
    .toSorted((a, b) => scopeRank(b.scope.kind) - scopeRank(a.scope.kind));
  const candidates = storedRows.filter((row) => !droppedRows.has(row));

  const [stored] = storedRows;
  const [winner, ...shadowed] = candidates;
  return { effective: winner?.value, stored, winner, shadowed, dropped };
}

export const displayedEnablement = (resolved: ResolvedEnablement) =>
  resolved.stored?.value ?? resolved.effective;

/** The workspace a Contribution's own settings resolve against. */
export function viewOf(contribution: Contribution): ViewContext {
  return { workspaceId: contribution.definedIn };
}

export function enableScopeFor(contribution: Contribution): ScopeRef | undefined {
  const permitted = enablementScopes[contribution.kind];
  const current = resolveEnablement(contribution, viewOf(contribution)).stored?.scope;
  if (current && permitted.includes(current.kind)) return current;
  const preferred = permitted.includes(contribution.definedAt) ? contribution.definedAt : permitted.at(-1);
  if (preferred === undefined) return undefined;
  if (preferred === "settings-profile") return { kind: preferred };
  if (contribution.definedIn === undefined) return undefined;
  return { kind: preferred, workspaceId: contribution.definedIn };
}

export function definedScope(contribution: Contribution): ScopeRef {
  if (contribution.definedAt === "settings-profile") return { kind: contribution.definedAt };
  if (contribution.definedIn === undefined) return { kind: contribution.definedAt };
  return { kind: contribution.definedAt, workspaceId: contribution.definedIn };
}

export function offeredElsewhere(contribution: Contribution): boolean {
  return !enablementScopes[contribution.kind].includes(contribution.definedAt);
}

export function settingsSpreadAcross(contribution: Contribution) {
  const admissible = contribution.rows.filter((row) => admissibleFor(contribution.kind, row));
  if (admissible.length < 2) return [];
  return admissible
    .toSorted((a, b) => scopeRank(b.scope.kind) - scopeRank(a.scope.kind))
    .map((row) => row.scope.kind);
}
