// PROTOTYPE MODEL — placeholder types for the Plugins / Customize / workspace surfaces.
//
// These mirror the vocabulary settled by #128, #132, #134, #125, #130, #135, #126 and #133
// (see `packages/contracts/CONTEXT.md`). They are deliberately *not* the real contracts
// schemas: nothing here is decoded, persisted, or sent over RPC. When the surfaces are wired
// to the daemon these types are replaced by the ones `@cogwork/contracts` owns.

/**
 * The Scopes a contribution can be configured at, low to high — the `override-scalar` direction.
 *
 * **Three rungs, not ADR 0013's four.** The Settings profile rung is gone: a contribution is a
 * file on disk on this machine, and ADR 0014 already conceded that nothing synchronizes a Settings
 * profile, so "principal-owned, shared across workspaces" and "this machine" never differed in
 * practice. Collapsing them removes a tier that could only ever have been a fiction.
 *
 * ADR 0013 and ADR 0014 both need amending for this. See the #131 resolution.
 */
export const scopeOrder = ["runtime-host", "workspace-input", "private-overlay"] as const;

export type ScopeKind = (typeof scopeOrder)[number];

export const scopeLabels: Record<ScopeKind, string> = {
  "runtime-host": "Runtime host",
  "workspace-input": "Workspace input",
  "private-overlay": "Private workspace overlay",
};

/**
 * Product copy, kept separate from the glossary names above on purpose.
 *
 * `scopeLabels` holds the terms the domain owns and is what a diagnostic, a provenance line or a
 * tooltip should say, because those have to be precise. This is what a person reads in a menu.
 *
 * **`Runtime host` shows as "User".** That is the maintainer's call, matching Cursor. It is worth
 * recording rather than burying: the glossary's `Settings profile` entry lists "User settings" on
 * its *Avoid* line, and this map collapsed Settings profile into Runtime host — so the avoided word
 * is now the chosen label for the Scope that absorbed it. A `/domain-modeling` act should settle
 * whether the glossary follows the copy or the copy keeps its distance.
 *
 * **The other two are named by audience, not by mechanism.** "Shared" and "Private" begged the
 * question — shared with whom, private from whom — and left the answer off screen. These two rows
 * always sit under a named workspace, so the only thing that separates them is who else gets the
 * file, and saying that outright makes each one define the other. "Checked in" and "Local" were the
 * runner-up: precise, and a mechanism a newcomer has to already understand.
 *
 * The hints are one clause each and parallel, so the three can be compared by reading down.
 */
export const scopeCopy: Record<ScopeKind, { readonly name: string; readonly hint: string }> = {
  "runtime-host": { name: "User", hint: "On this machine, in every workspace." },
  "workspace-input": { name: "Everyone", hint: "In the repo, for anyone who clones it." },
  "private-overlay": { name: "Just me", hint: "On your machine, never committed." },
};

/** Phrased as a place, for a row that says where one contribution came from. */
export const scopeOriginLabels: Record<ScopeKind, string> = {
  "runtime-host": "on this machine",
  "workspace-input": "in the repository",
  "private-overlay": "in your private overlay",
};

/**
 * A Scope instance. The two workspace Scopes name a workspace; the other two do not.
 * Folder path and git remote are hints for re-binding, never identity — so a ScopeRef
 * carries the minted `WorkspaceId` and nothing derived from the environment.
 */
export interface ScopeRef {
  readonly kind: ScopeKind;
  readonly workspaceId?: WorkspaceId;
}

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export function scopeKey(scope: ScopeRef): string {
  return scope.workspaceId ? `${scope.kind}:${scope.workspaceId}` : scope.kind;
}

export function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.kind === b.kind && a.workspaceId === b.workspaceId;
}

/** The six contribution kinds. The list is closed (#132). */
export const contributionKinds = ["mcp-server", "skill", "subagent", "rules", "command", "hook"] as const;

export type ContributionKind = (typeof contributionKinds)[number];

export const kindLabels: Record<ContributionKind, string> = {
  "mcp-server": "MCP server",
  skill: "Skill",
  subagent: "Subagent",
  rules: "Rules",
  command: "Command",
  hook: "Hook",
};

export const kindLabelsPlural: Record<ContributionKind, string> = {
  "mcp-server": "MCP servers",
  skill: "Skills",
  subagent: "Subagents",
  rules: "Rules",
  command: "Commands",
  hook: "Hooks",
};

/**
 * Which Scopes may hold a contribution's on / off, by kind (ADR 0013).
 *
 * The Workspace input is excluded for Hook and MCP server because a repository you cloned
 * must not start a process on your machine. It may still *ship* the file. That cell is empty by
 * decision, so a UI that renders it as merely unset is lying.
 */
export const enablementScopes: Record<ContributionKind, readonly ScopeKind[]> = {
  skill: ["runtime-host", "workspace-input", "private-overlay"],
  rules: ["runtime-host", "workspace-input", "private-overlay"],
  command: ["runtime-host", "workspace-input", "private-overlay"],
  subagent: ["runtime-host", "workspace-input", "private-overlay"],
  hook: ["runtime-host", "private-overlay"],
  "mcp-server": ["runtime-host", "private-overlay"],
};

/** Which Scopes may hold an Operation setting. The Runtime host takes `harness` and nothing else. */
/**
 * PARKED — dropping the Settings profile rung leaves this set undecided. ADR 0013 gave the Runtime
 * host `harness` and nothing else *because* the profile held the rest; with the profile gone that
 * reasoning has no subject. Operation settings live on the Workflows page, so the question is
 * parked there rather than answered here.
 */
export const operationSettingScopes: Record<OperationSettingKey, readonly ScopeKind[]> = {
  enabled: ["runtime-host", "private-overlay"],
  harness: ["runtime-host", "private-overlay"],
  model: ["runtime-host", "private-overlay"],
  effort: ["runtime-host", "private-overlay"],
  "permission-profile": ["runtime-host", "private-overlay"],
  binding: ["runtime-host", "private-overlay"],
};

export type OperationSettingKey =
  | "enabled"
  | "harness"
  | "model"
  | "effort"
  | "permission-profile"
  | "binding";

/** Who authored a contribution. Part of its immutable identity, and orthogonal to Scope. */
export type Authority =
  | { readonly _tag: "plugin"; readonly pluginId: string }
  | { readonly _tag: "engine" }
  | { readonly _tag: "local" };

export function authorityLabel(authority: Authority): string {
  return authority._tag === "plugin" ? `plugin:${authority.pluginId}` : authority._tag;
}

/** The four conflict classes (#134). Only `unsatisfiable` waits for a Run. */
export type Diagnostic =
  | { readonly _tag: "inadmissible"; readonly detail: string; readonly source: string }
  | { readonly _tag: "dangling"; readonly detail: string; readonly source: string }
  | { readonly _tag: "ambiguous"; readonly detail: string; readonly source: string };

export const diagnosticLabels: Record<Diagnostic["_tag"], string> = {
  inadmissible: "Inadmissible",
  dangling: "Dangling",
  ambiguous: "Ambiguous",
};

/**
 * One written on / off, at one Scope. Clients receive rows and resolve the ladder themselves
 * (#133) — so the absent case is genuinely absent here, never a `false`.
 */
export interface EnablementRow {
  readonly scope: ScopeRef;
  readonly value: boolean;
  readonly source: string;
  readonly diagnostic?: Diagnostic;
}

/**
 * What one `(contribution identity, Scope)` cell holds. Three states, because #133's act is "set
 * *or clear*" and #134 fixed that absence is not `false` — a switch cannot say this.
 */
export type DraftCell = "on" | "off" | "unset";

/** Whether the file a manifest points at actually parsed. A failure yields no contribution. */
export type LoadState = { readonly _tag: "loaded" } | { readonly _tag: "failed"; readonly reason: string };

export interface Contribution {
  /** `<authority>/<kind>/<localName>`, e.g. `plugin:linear/mcp/linear`. */
  readonly id: string;
  readonly kind: ContributionKind;
  readonly localName: string;
  readonly authority: Authority;
  readonly summary: string;
  /** The file the manifest points at. A Plugin references files; it never inlines them. */
  readonly file: string;
  /**
   * Which Scope the file itself sits in. A contribution's file lives in exactly one place, which
   * is why the level control is a filter over locations rather than a precedence ladder.
   *
   * The glossary has no term for this: `Scope` is where a *setting* lives and `Plugin source` is
   * where a *Plugin's* files come from. Naming it is a `/domain-modeling` act, so this field uses
   * a plain description instead of minting one.
   */
  readonly definedAt: ScopeKind;
  /**
   * Which workspace, when `definedAt` is one of the two workspace-bound Scopes. Absent for anything
   * on the machine. A place is not fully named without it: "the repository" is not an answer until
   * you say which repository, and two workspaces here share one git remote.
   */
  readonly definedIn?: WorkspaceId;
  readonly load: LoadState;
  readonly rows: readonly EnablementRow[];
  /** Engine-owned, MCP servers only. Clients show Operation availability from the same result. */
  readonly readiness?: McpReadiness;
}

export type McpReadiness =
  | { readonly _tag: "ready" }
  | { readonly _tag: "not-ready"; readonly reason: string };

export type PluginSource =
  | { readonly _tag: "catalog"; readonly entryId: string }
  | { readonly _tag: "local-path"; readonly path: string };

/** The authority for *this Plugin is installed*. Keyed by pluginId, so one identity at a time. */
export interface InstallRecord {
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly resolvedIdentity: string;
  readonly pinned: boolean;
  readonly principal: string;
  readonly revision: number;
  readonly installedAt: string;
}

/**
 * Update state. `staged` is ADR 0014's atomic provision seen mid-flight: the bytes are at a key
 * nothing points at, and one act accepts or declines them.
 */
export type UpdateState =
  | { readonly _tag: "current" }
  | { readonly _tag: "available"; readonly resolvedIdentity: string }
  | { readonly _tag: "staged"; readonly resolvedIdentity: string; readonly reach: ReachDiff };

/**
 * A diff of reach over the contributions currently **on** — the only ones that run under the new
 * bytes with no further act. Additions and drops are enumerated beside it without their reach.
 */
export interface ReachDiff {
  readonly changed: readonly {
    readonly contributionId: string;
    readonly before: string;
    readonly after: string;
  }[];
  readonly added: readonly { readonly contributionId: string; readonly kind: ContributionKind }[];
  readonly dropped: readonly { readonly contributionId: string; readonly kind: ContributionKind }[];
}

/**
 * Derived from the bundle's files, never declared. Three postures are enforced exactly; anything
 * finer is coarse, and the recorded fidelity travels with the row so no client claims exactness.
 */
export interface PermissionRow {
  readonly label: string;
  readonly detail: string;
  readonly fidelity: "exact" | "coarse";
}

export interface InstalledPlugin {
  readonly record: InstallRecord;
  readonly name: string;
  readonly summary: string;
  readonly contributionIds: readonly string[];
  readonly permissions: readonly PermissionRow[];
  /** Names a required Connection and nothing about the grant. */
  readonly requiredConnections: readonly string[];
  readonly update: UpdateState;
  readonly setup: readonly SetupStep[];
}

export interface SetupStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

export type CatalogStatus =
  | { readonly _tag: "active" }
  | { readonly _tag: "deprecated"; readonly message?: string }
  | { readonly _tag: "deleted"; readonly message?: string };

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly source: PluginSource;
  /** Computed, not authored — so it can only be stale, never in disagreement. */
  readonly digest: string;
  readonly status: CatalogStatus;
  readonly contributes: readonly ContributionKind[];
}

/** Three arms, because two of them must not render alike (#125). */
export type CatalogRead =
  | { readonly _tag: "fetched"; readonly at: string; readonly entries: readonly CatalogEntry[] }
  | {
      readonly _tag: "stale";
      readonly at: string;
      readonly entries: readonly CatalogEntry[];
      readonly lastFailure: string;
    }
  | { readonly _tag: "never-fetched" };

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  /** A hint for re-binding, never identity. */
  readonly checkoutPath: string;
  /** Also a hint. Two workspaces may share one remote. */
  readonly remote?: string;
  readonly tracker: string;
}

/** A required need declared by the Operation Definition. Settings bind; the Definition declares. */
export interface Need {
  readonly id: string;
  readonly label: string;
  readonly kind: ContributionKind;
  readonly boundContributionId?: string;
  readonly satisfied: boolean;
  /** Present when unsatisfiable — a Run Plan rejection reason, knowable only for a Run. */
  readonly reason?: string;
}

/** `default` < `workflow` < `operation`. The most specific wins *before* Scope is consulted. */
export const settingLevels = ["default", "workflow", "operation"] as const;

export type SettingLevel = (typeof settingLevels)[number];

export interface OperationSettingRow {
  readonly key: OperationSettingKey;
  readonly level: SettingLevel;
  readonly scope: ScopeRef;
  readonly value: string;
  readonly source: string;
  /** Present when the Engine refused the value. A ceiling constrains and names its source. */
  readonly refusedBy?: string;
}

export interface Operation {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly needs: readonly Need[];
  readonly rows: readonly OperationSettingRow[];
  /** Settings the Operation Definition locks against override. The lock *is* Engine policy. */
  readonly locked: readonly OperationSettingKey[];
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly operationIds: readonly string[];
}

export interface DaemonLimits {
  readonly globalConcurrency: number;
  readonly perWorkspaceConcurrency: number;
  readonly dailyBudget: number;
}

export interface ControlStoreState {
  readonly schemaVersion: number;
  readonly openedAt: string;
  /** ADR 0015's restore: the pre-migration copy, when one exists. */
  readonly preMigrationCopy?: { readonly at: string; readonly fromVersion: number };
}

export interface ConfigurationPicture {
  readonly principal: string;
  readonly hostId: string;
  readonly workspaces: readonly Workspace[];
  readonly plugins: readonly InstalledPlugin[];
  readonly contributions: readonly Contribution[];
  readonly catalog: CatalogRead;
  readonly workflows: readonly Workflow[];
  readonly operations: readonly Operation[];
  readonly limits: DaemonLimits;
  readonly controlStore: ControlStoreState;
}
