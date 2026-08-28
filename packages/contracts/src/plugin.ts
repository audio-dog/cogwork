import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";
import { ConnectionId } from "./connection";
import { FileContributionKind, PluginContributionAuthority } from "./contribution";
import { PrincipalId } from "./principal";

export const PluginId = TrimmedNonEmptyString;
export type PluginId = typeof PluginId.Type;

export const PluginInstall = Schema.Struct({
  pluginId: PluginId,
  resolvedIdentity: TrimmedNonEmptyString,
  principal: PrincipalId,
  installedAtMillis: Schema.Natural,
});
export type PluginInstall = typeof PluginInstall.Type;

export const PluginMcpServer = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  secretEnv: Schema.NullOr(TrimmedNonEmptyString),
  credentialAvailable: Schema.Boolean,
  connectionId: Schema.optionalKey(ConnectionId),
});
export type PluginMcpServer = typeof PluginMcpServer.Type;

export const PluginContributionLoad = Schema.TaggedUnion({
  Loaded: {
    mcpServer: Schema.optionalKey(PluginMcpServer),
  },
  Failed: {
    reason: TrimmedNonEmptyString,
  },
});
export type PluginContributionLoad = typeof PluginContributionLoad.Type;

export const PluginContribution = Schema.Struct({
  id: TrimmedNonEmptyString,
  authority: PluginContributionAuthority,
  kind: FileContributionKind,
  localName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
  load: PluginContributionLoad,
});
export type PluginContribution = typeof PluginContribution.Type;

export const PluginItem = Schema.Struct({
  pluginId: PluginId,
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  record: Schema.NullOr(PluginInstall),
  resolvedIdentity: Schema.NullOr(TrimmedNonEmptyString),
  requiredConnections: Schema.Array(TrimmedNonEmptyString),
  contributions: Schema.Array(PluginContribution),
  manifestFailure: Schema.NullOr(TrimmedNonEmptyString),
});
export type PluginItem = typeof PluginItem.Type;

export const PluginOverview = Schema.Struct({
  plugins: Schema.Array(PluginItem),
});
export type PluginOverview = typeof PluginOverview.Type;

export const PluginMutationResult = Schema.Struct({
  overview: PluginOverview,
  notices: Schema.Array(TrimmedNonEmptyString),
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export const ContributionSettingScope = Schema.Union([
  Schema.TaggedStruct("SettingsProfile", {}),
  Schema.TaggedStruct("PrivateWorkspaceOverlay", {
    workspace: WorkspaceId,
  }),
]);
export type ContributionSettingScope = typeof ContributionSettingScope.Type;

export const ContributionSetting = Schema.Struct({
  contribution: TrimmedNonEmptyString,
  scope: ContributionSettingScope,
  enabled: Schema.Boolean,
});
export type ContributionSetting = typeof ContributionSetting.Type;

export class PluginFailure extends Schema.TaggedError<PluginFailure>()("PluginFailure", {
  operation: TrimmedNonEmptyString,
  pluginId: Schema.NullOr(PluginId),
  file: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
}) {}

export const pluginContributionId = (pluginId: string, kind: FileContributionKind, localName: string) =>
  `plugin:${pluginId}/${kind === "mcp-server" ? "mcp" : kind}/${localName}`;
