import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base-schemas";
import { ConnectionId, ConnectionSystem } from "./connection";
import { DisableModelInvocation, FileContributionKind, PluginContributionAuthority } from "./contribution";
import { PrincipalId } from "./principal";
import { ProvenanceStamp } from "./provenance";

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
  disableModelInvocation: DisableModelInvocation,
  load: PluginContributionLoad,
});
export type PluginContribution = typeof PluginContribution.Type;

export const PluginItem = Schema.Struct({
  pluginId: PluginId,
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  record: Schema.NullOr(PluginInstall),
  resolvedIdentity: Schema.NullOr(TrimmedNonEmptyString),
  provenanceStamp: Schema.optionalKey(Schema.NullOr(ProvenanceStamp)),
  requiredConnections: Schema.Array(ConnectionSystem),
  contributions: Schema.Array(PluginContribution),
  manifestFailure: Schema.NullOr(TrimmedNonEmptyString),
});
export type PluginItem = typeof PluginItem.Type;

export const PluginOverview = Schema.Struct({
  plugins: Schema.Array(PluginItem),
});
export type PluginOverview = typeof PluginOverview.Type;

// At most one first-party Plugin may require a given Connection, so this answers one bundle or none,
// never a set. It lives in the kernel because the Engine and every client derive it from the same
// overview: a second copy of the rule is a second place to change when the tie-break moves.
export const pluginRequiringConnection = (plugins: PluginOverview, system: ConnectionSystem) =>
  plugins.plugins.find((plugin) => plugin.requiredConnections.includes(system)) ?? null;

export const PluginMutationResult = Schema.Struct({
  overview: PluginOverview,
  notices: Schema.Array(TrimmedNonEmptyString),
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export class PluginFailure extends Schema.TaggedError<PluginFailure>()("PluginFailure", {
  operation: TrimmedNonEmptyString,
  pluginId: Schema.NullOr(PluginId),
  file: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
}) {}

export const pluginContributionId = (pluginId: string, kind: FileContributionKind, localName: string) =>
  `plugin:${pluginId}/${kind === "mcp-server" ? "mcp" : kind}/${localName}`;
