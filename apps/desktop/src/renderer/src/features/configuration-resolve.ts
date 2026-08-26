import {
  type Contribution,
  type ContributionKind,
  type Diagnostic,
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
  readonly winner?: EnablementRow;
  readonly shadowed: readonly EnablementRow[];
  readonly dropped: readonly DroppedRow[];
}

export function resolveEnablement(contribution: Contribution, view: ViewContext): ResolvedEnablement {
  const visible = contribution.rows.filter((row) => inView(row, view));

  const dropped = visible
    .filter((row) => row.diagnostic !== undefined || !admissibleFor(contribution.kind, row))
    .map((row) => ({
      row,
      diagnostic: row.diagnostic ?? {
        _tag: "inadmissible" as const,
        detail: `A ${contribution.kind} on / off may not be written at the ${row.scope.kind} Scope.`,
        source: row.source,
      },
    }));

  const droppedRows = new Set(dropped.map((entry) => entry.row));
  const candidates = visible
    .filter((row) => !droppedRows.has(row))
    .toSorted((a, b) => scopeRank(b.scope.kind) - scopeRank(a.scope.kind));

  const [winner, ...shadowed] = candidates;
  return { effective: winner?.value, winner, shadowed, dropped };
}

export function enableScopeFor(contribution: Contribution): ScopeRef | undefined {
  const permitted = enablementScopes[contribution.kind];
  const preferred = permitted.includes(contribution.definedAt) ? contribution.definedAt : permitted.at(-1);
  if (preferred === undefined) return undefined;
  if (preferred === "settings-profile") return { kind: preferred };
  if (contribution.definedIn === undefined) return undefined;
  return { kind: preferred, workspaceId: contribution.definedIn };
}

export function definedScope(contribution: Contribution): ScopeRef {
  return contribution.definedIn === undefined
    ? { kind: contribution.definedAt }
    : { kind: contribution.definedAt, workspaceId: contribution.definedIn };
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
