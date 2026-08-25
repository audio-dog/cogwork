// PROTOTYPE MODEL — placeholder types for the Plugins / Customize / workspace surfaces.
//
// These mirror the vocabulary settled by #128, #132, #134, #125, #130, #135, #126 and #133
// (see `packages/contracts/CONTEXT.md`). They are deliberately *not* the real contracts
// schemas: nothing here is decoded, persisted, or sent over RPC. When the surfaces are wired
// to the daemon these types are replaced by the ones `@cogwork/contracts` owns.

/** The four Scopes. Ordered low to high — the `override-scalar` direction from ADR 0013. */
export const scopeOrder = ["settings-profile", "runtime-host", "workspace-input", "private-overlay"] as const;

export type ScopeKind = (typeof scopeOrder)[number];

export const scopeLabels: Record<ScopeKind, string> = {
  "settings-profile": "Settings profile",
  "runtime-host": "Runtime host",
  "workspace-input": "Workspace input",
  "private-overlay": "Private workspace overlay",
};

/** What each Scope's identity is minted from (#134). Rendered so a person can tell two clones apart. */
export const scopeIdentity: Record<ScopeKind, string> = {
  "settings-profile": "the Principal",
  "runtime-host": "a HostId, minted once and kept in this machine's ~/.cogwork",
  "workspace-input": "a WorkspaceId, minted at registration",
  "private-overlay": "the pair (Principal, WorkspaceId)",
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
 * must not start a process on your machine. It may still *ship* the file. The excluded cells
 * are empty by decision, so a UI that renders them as unset is lying.
 */
export const enablementScopes: Record<ContributionKind, readonly ScopeKind[]> = {
  skill: ["settings-profile", "workspace-input", "private-overlay"],
  rules: ["settings-profile", "workspace-input", "private-overlay"],
  command: ["settings-profile", "workspace-input", "private-overlay"],
  subagent: ["settings-profile", "workspace-input", "private-overlay"],
  hook: ["settings-profile", "private-overlay"],
  "mcp-server": ["settings-profile", "private-overlay"],
};

/** Which Scopes may hold an Operation setting. The Runtime host takes `harness` and nothing else. */
export const operationSettingScopes: Record<OperationSettingKey, readonly ScopeKind[]> = {
  enabled: ["settings-profile", "private-overlay"],
  harness: ["settings-profile", "runtime-host", "private-overlay"],
  model: ["settings-profile", "private-overlay"],
  effort: ["settings-profile", "private-overlay"],
  "permission-profile": ["settings-profile", "private-overlay"],
  binding: ["settings-profile", "private-overlay"],
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
