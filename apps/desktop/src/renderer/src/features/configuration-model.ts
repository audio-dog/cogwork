export const scopeOrder = ["runtime-host", "workspace-input", "private-overlay"] as const;

export type ScopeKind = (typeof scopeOrder)[number];

export const scopeCopy: Record<ScopeKind, { readonly name: string; readonly hint: string }> = {
  "runtime-host": { name: "User", hint: "On this machine, in every workspace." },
  "workspace-input": { name: "Everyone", hint: "In the repo, for anyone who clones it." },
  "private-overlay": { name: "Just me", hint: "On your machine, never committed." },
};

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

export const enablementScopes: Record<ContributionKind, readonly ScopeKind[]> = {
  skill: [],
  rules: [],
  command: [],
  subagent: [],
  hook: ["runtime-host", "private-overlay"],
  "mcp-server": ["runtime-host", "private-overlay"],
};

export function hasToggle(kind: ContributionKind): boolean {
  return enablementScopes[kind].length > 0;
}

export type Authority =
  | { readonly _tag: "plugin"; readonly pluginId: string }
  | { readonly _tag: "engine" }
  | { readonly _tag: "local" };

export function authorityLabel(authority: Authority): string {
  return authority._tag === "plugin" ? `plugin:${authority.pluginId}` : authority._tag;
}

export type Diagnostic =
  | { readonly _tag: "inadmissible"; readonly detail: string; readonly source: string }
  | { readonly _tag: "dangling"; readonly detail: string; readonly source: string }
  | { readonly _tag: "ambiguous"; readonly detail: string; readonly source: string };

export const diagnosticLabels: Record<Diagnostic["_tag"], string> = {
  inadmissible: "Inadmissible",
  dangling: "Dangling",
  ambiguous: "Ambiguous",
};

export interface EnablementRow {
  readonly scope: ScopeRef;
  readonly value: boolean;
  readonly source: string;
  readonly diagnostic?: Diagnostic;
}

export type DraftCell = "on" | "off" | "unset";

export type LoadState = { readonly _tag: "loaded" } | { readonly _tag: "failed"; readonly reason: string };

export interface Contribution {
  readonly id: string;
  readonly kind: ContributionKind;
  readonly localName: string;
  readonly authority: Authority;
  readonly summary: string;
  readonly file: string;
  readonly definedAt: ScopeKind;
  readonly definedIn?: WorkspaceId;
  readonly load: LoadState;
  readonly rows: readonly EnablementRow[];
  readonly readiness?: McpReadiness;
}

export type McpReadiness =
  | { readonly _tag: "ready" }
  | { readonly _tag: "not-ready"; readonly reason: string };

export type PluginSource =
  | { readonly _tag: "catalog"; readonly entryId: string }
  | { readonly _tag: "local-path"; readonly path: string };

export interface InstallRecord {
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly resolvedIdentity: string;
  readonly principal: string;
  readonly revision: number;
  readonly installedAt: string;
}

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
  readonly requiredConnections: readonly string[];
  readonly setup: readonly SetupStep[];
}

export interface SetupStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly contributes: readonly ContributionKind[];
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly checkoutPath: string;
  readonly remote?: string;
  readonly tracker: string;
}

export interface DaemonLimits {
  readonly globalConcurrency: number;
  readonly perWorkspaceConcurrency: number;
  readonly dailyBudget: number;
}

export interface ControlStoreState {
  readonly schemaVersion: number;
  readonly openedAt: string;
  readonly preMigrationCopy?: { readonly at: string; readonly fromVersion: number };
}

export interface ConfigurationPicture {
  readonly principal: string;
  readonly hostId: string;
  readonly workspaces: readonly Workspace[];
  readonly plugins: readonly InstalledPlugin[];
  readonly contributions: readonly Contribution[];
  readonly catalog: readonly CatalogEntry[];
  readonly limits: DaemonLimits;
  readonly controlStore: ControlStoreState;
}
