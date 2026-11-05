import type { WorkspaceId } from "@cogwork/contracts";
import * as Data from "effect/Data";

export const scopeOrder = ["settings-profile", "workspace-input", "private-overlay"] as const;

export type ScopeKind = (typeof scopeOrder)[number];

export const scopeCopy: Record<ScopeKind, { readonly name: string; readonly hint: string }> = {
  "settings-profile": { name: "User", hint: "Yours, in every workspace." },
  "workspace-input": { name: "Everyone", hint: "In the repo, for anyone who clones it." },
  "private-overlay": { name: "Just me", hint: "On your machine, never committed." },
};

export interface ScopeRef {
  readonly kind: ScopeKind;
  readonly workspaceId?: WorkspaceId;
}

export type { WorkspaceId };
export function scopeKey(scope: ScopeRef): string {
  return scope.workspaceId ? `${scope.kind}:${scope.workspaceId}` : scope.kind;
}

export const contributionKinds = ["mcp-server", "skill", "subagent", "rules", "hook"] as const;

export type ContributionKind = (typeof contributionKinds)[number];

export const kindLabels: Record<ContributionKind, string> = {
  "mcp-server": "MCP server",
  skill: "Skill",
  subagent: "Subagent",
  rules: "Rules",
  hook: "Hook",
};

export const kindLabelsPlural: Record<ContributionKind, string> = {
  "mcp-server": "MCP servers",
  skill: "Skills",
  subagent: "Subagents",
  rules: "Rules",
  hook: "Hooks",
};

export const enablementScopes: Record<ContributionKind, readonly ScopeKind[]> = {
  skill: [],
  rules: [],
  subagent: [],
  hook: [],
  "mcp-server": ["settings-profile", "private-overlay"],
};

export function hasToggle(kind: ContributionKind): boolean {
  return enablementScopes[kind].length > 0;
}

export const authoringTrees = ["user", "repo", "private"] as const;

export type AuthoringTree = (typeof authoringTrees)[number];

export const treeScope: Record<AuthoringTree, ScopeKind> = {
  user: "settings-profile",
  repo: "workspace-input",
  private: "private-overlay",
};

export const treePath: Record<AuthoringTree, string> = {
  user: "~/.agents/",
  repo: "<repo>/.agents/",
  private: "~/.cogwork/workspaces/<WorkspaceId>/",
};

declare const emptyVariant: unique symbol;
type EmptyVariant = { readonly [emptyVariant]?: never };

export type Authority = Data.TaggedEnum<{
  plugin: { readonly pluginId: string };
  engine: EmptyVariant;
  local: { readonly tree: AuthoringTree };
}>;

export const Authority = Data.taggedEnum<Authority>();

export const authorityLabel = Authority.$match({
  plugin: ({ pluginId }) => `plugin:${pluginId}`,
  engine: () => "engine",
  local: ({ tree }) => `local:${tree}`,
});

interface DiagnosticFields {
  readonly detail: string;
  readonly source: string;
}

export type Diagnostic = Data.TaggedEnum<{
  inadmissible: DiagnosticFields;
  dangling: DiagnosticFields;
  ambiguous: DiagnosticFields;
}>;

export const Diagnostic = Data.taggedEnum<Diagnostic>();

export const diagnosticLabel = Diagnostic.$match({
  inadmissible: () => "Inadmissible",
  dangling: () => "Dangling",
  ambiguous: () => "Ambiguous",
});

export interface EnablementRow {
  readonly scope: ScopeRef;
  readonly value: boolean;
  readonly source: string;
  readonly diagnostic?: Diagnostic;
}

export type LoadState = Data.TaggedEnum<{
  loaded: EmptyVariant;
  failed: { readonly reason: string };
}>;

export const LoadState = Data.taggedEnum<LoadState>();

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

export const contributionInstanceKey = (contribution: Contribution) =>
  contribution.definedIn ? `${contribution.id}:${contribution.definedIn}` : contribution.id;

export type McpReadiness = Data.TaggedEnum<{
  ready: EmptyVariant;
  "not-ready": { readonly reason: string };
}>;

export const McpReadiness = Data.taggedEnum<McpReadiness>();

export interface InstallRecord {
  readonly pluginId: string;
  readonly resolvedIdentity: string;
  readonly principal: string;
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
  readonly manifestFailure: string | null;
  readonly contributionIds: readonly string[];
  readonly permissions: readonly PermissionRow[];
  readonly requiredConnections: readonly string[];
  readonly setup: readonly SetupStep[];
}

export interface CatalogPlugin {
  readonly pluginId: string;
  readonly name: string;
  readonly summary: string;
  readonly resolvedIdentity: string | null;
  readonly manifestFailure: string | null;
}

export interface SetupStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly checkoutPath: string;
  readonly remote?: string;
}

export interface ConfigurationPicture {
  readonly workspaces: readonly Workspace[];
  readonly plugins: readonly InstalledPlugin[];
  readonly catalogPlugins: readonly CatalogPlugin[];
  readonly contributions: readonly Contribution[];
}
