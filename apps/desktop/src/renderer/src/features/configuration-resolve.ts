// PROTOTYPE RESOLVER — the client half of "rows, not effective values" (#133).
//
// The daemon sends rows. Each client resolves the ladder itself, which is why this lives beside
// the surfaces rather than inside them: all three variants render the same answer.

import {
  type Contribution,
  type ContributionKind,
  type Diagnostic,
  type EnablementRow,
  enablementScopes,
  type Operation,
  type OperationSettingKey,
  type OperationSettingRow,
  operationSettingScopes,
  type ScopeKind,
  type ScopeRef,
  type SettingLevel,
  scopeOrder,
  settingLevels,
  type WorkspaceId,
} from "./configuration-model";

/** Where the person is looking. The two workspace Scopes only apply inside a workspace. */
export interface ViewContext {
  readonly workspaceId?: WorkspaceId;
}

function scopeRank(kind: ScopeKind): number {
  return scopeOrder.indexOf(kind);
}

function levelRank(level: SettingLevel): number {
  return settingLevels.indexOf(level);
}

/** A row is in view when its Scope is not workspace-bound, or is bound to the workspace in view. */
function inView(row: { readonly scope: ScopeRef }, view: ViewContext): boolean {
  if (row.scope.workspaceId === undefined) return true;
  return row.scope.workspaceId === view.workspaceId;
}

/**
 * A row whose Scope its family does not accept is *inadmissible*: the value is dropped and a
 * diagnostic names the file. Never silently ignored, and never a hard error.
 */
function admissibleFor(kind: ContributionKind, row: EnablementRow): boolean {
  return enablementScopes[kind].includes(row.scope.kind);
}

export interface DroppedRow {
  readonly row: EnablementRow;
  readonly diagnostic: Diagnostic;
}

/**
 * The resolved on / off for one contribution, with the trace behind it.
 *
 * `effective` is `undefined` when nothing admissible was written at any Scope in view. Absence is
 * not `false` — a Scope that says nothing shadows nothing — so the surfaces render a third state.
 */
export interface ResolvedEnablement {
  readonly effective?: boolean;
  readonly winner?: EnablementRow;
  /** Admissible rows the winner outranked, highest Scope first. */
  readonly shadowed: readonly EnablementRow[];
  readonly dropped: readonly DroppedRow[];
  /** Scopes this kind may be written at, in ladder order. */
  readonly ladder: readonly ScopeKind[];
}

export function resolveEnablement(contribution: Contribution, view: ViewContext): ResolvedEnablement {
  const ladder = enablementScopes[contribution.kind];
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
  return { effective: winner?.value, winner, shadowed, dropped, ladder };
}

export interface ResolvedOperationSetting {
  readonly key: OperationSettingKey;
  readonly value?: string;
  readonly winner?: OperationSettingRow;
  readonly shadowed: readonly OperationSettingRow[];
  readonly dropped: readonly OperationSettingRow[];
  readonly locked: boolean;
  readonly refusedBy?: string;
}

/**
 * PARKED — Operation settings live on the Workflows page, which is a placeholder. Kept because it
 * encodes #134's level-before-Scope rule and its tests are the record of that decision.
 *
 * The most specific level wins *before* Scope is consulted. A default must never outrank a value
 * that names the work, or one global value in your overlay silently replaces every per-Operation
 * value in your own profile.
 */
export function resolveOperationSetting(
  operation: Operation,
  key: OperationSettingKey,
  view: ViewContext,
): ResolvedOperationSetting {
  const allowed = operationSettingScopes[key];
  const visible = operation.rows.filter((row) => row.key === key && inView(row, view));
  const dropped = visible.filter((row) => !allowed.includes(row.scope.kind));
  const candidates = visible
    .filter((row) => allowed.includes(row.scope.kind))
    .toSorted(
      (a, b) => levelRank(b.level) - levelRank(a.level) || scopeRank(b.scope.kind) - scopeRank(a.scope.kind),
    );

  const [winner, ...shadowed] = candidates;
  return {
    key,
    value: winner?.value,
    winner,
    shadowed,
    dropped,
    locked: operation.locked.includes(key),
    refusedBy: candidates.find((row) => row.refusedBy !== undefined)?.refusedBy,
  };
}

/** Whether a cell may legally hold a value at all. An illegal cell is not an unset cell. */
export function cellPermitted(kind: ContributionKind, scope: ScopeKind): boolean {
  return enablementScopes[kind].includes(scope);
}

export interface AttentionItem {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly title: string;
  readonly detail: string;
  readonly surface: "plugins" | "customize" | "workspaces";
}

/**
 * PARKED — nothing renders this yet. #131's brief asked for needs-attention states and the
 * Workflows page is where they land; the tests hold the shape until it exists. Delete it with the
 * prototype if that page takes a different route.
 *
 * Everything a person should be told without being asked, gathered from the same rows the
 * surfaces render. Load-time classes appear here; `unsatisfiable` does too, because a rejected
 * Run Plan is the one class that only a Run can discover.
 */
export function collectAttention(
  contributions: readonly Contribution[],
  operations: readonly Operation[],
  plugins: readonly { readonly name: string; readonly update: { readonly _tag: string } }[],
  view: ViewContext,
): readonly AttentionItem[] {
  const failedLoads = contributions
    .filter((contribution) => contribution.load._tag === "failed")
    .map((contribution) => ({
      id: `load:${contribution.id}`,
      severity: "error" as const,
      title: `${contribution.localName} failed to load`,
      detail: contribution.load._tag === "failed" ? contribution.load.reason : "",
      surface: "customize" as const,
    }));

  const diagnostics = contributions.flatMap((contribution) =>
    resolveEnablement(contribution, view).dropped.map((entry) => ({
      id: `${entry.diagnostic._tag}:${contribution.id}:${entry.row.scope.kind}`,
      severity: entry.diagnostic._tag === "ambiguous" ? ("error" as const) : ("warning" as const),
      title: `${contribution.localName}: ${entry.diagnostic._tag}`,
      detail: entry.diagnostic.detail,
      surface: "customize" as const,
    })),
  );

  const unmet = operations.flatMap((operation) =>
    operation.needs
      .filter((need) => !need.satisfied)
      .map((need) => ({
        id: `need:${operation.id}:${need.id}`,
        severity: "error" as const,
        title: `${operation.name} cannot run`,
        detail: need.reason ?? `${need.label} is not satisfied.`,
        surface: "customize" as const,
      })),
  );

  const staged = plugins
    .filter((plugin) => plugin.update._tag === "staged")
    .map((plugin) => ({
      id: `update:${plugin.name}`,
      severity: "warning" as const,
      title: `${plugin.name} has an update waiting`,
      detail: "The bytes are staged. Accepting repoints the install record; declining discards them.",
      surface: "plugins" as const,
    }));

  return [...failedLoads, ...diagnostics, ...unmet, ...staged];
}

/**
 * Where this contribution's on / off should be written.
 *
 * Normally the same place its file lives — you turn a thing on where it is. The exception is the
 * one ADR 0013 cares about: a repository may ship an executable contribution but may never enable
 * one, so a repo-defined Hook or MCP server is switched on in your own overlay instead.
 */
export function enableScopeFor(contribution: Contribution): ScopeRef | undefined {
  const permitted = enablementScopes[contribution.kind];
  const preferred = permitted.includes(contribution.definedAt) ? contribution.definedAt : permitted.at(-1);
  if (preferred === undefined) return undefined;
  if (preferred === "runtime-host") return { kind: preferred };
  // A workspace-bound Scope belongs to the workspace this contribution lives in — never to
  // whichever workspace happens to be selected in some picker.
  if (contribution.definedIn === undefined) return undefined;
  return { kind: preferred, workspaceId: contribution.definedIn };
}

/** The place a contribution's file sits, fully named. */
export function definedScope(contribution: Contribution): ScopeRef {
  return contribution.definedIn === undefined
    ? { kind: contribution.definedAt }
    : { kind: contribution.definedAt, workspaceId: contribution.definedIn };
}

/** True when a repository offers this but cannot be the place it is turned on. */
export function offeredElsewhere(contribution: Contribution): boolean {
  return !enablementScopes[contribution.kind].includes(contribution.definedAt);
}

/**
 * The exception worth a badge: one identity carrying a setting at more than one Scope. This is the
 * only case ADR 0013's direction ever decides, and it is rare enough to render as an exception
 * rather than as the shape of the whole page.
 */
export function settingsSpreadAcross(contribution: Contribution, view: ViewContext): readonly ScopeKind[] {
  const resolved = resolveEnablement(contribution, view);
  if (resolved.shadowed.length === 0) return [];
  return [resolved.winner, ...resolved.shadowed]
    .filter((row) => row !== undefined)
    .map((row) => row.scope.kind);
}
