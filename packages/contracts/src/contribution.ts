import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./base-schemas";

export const LocalContributionAuthority = Schema.Literals(["local:user", "local:repo", "local:private"]);
export type LocalContributionAuthority = typeof LocalContributionAuthority.Type;

export const FileContributionKind = Schema.Literals(["mcp-server", "skill", "subagent", "rules"]);
export type FileContributionKind = typeof FileContributionKind.Type;

export const LocalContribution = Schema.Struct({
  id: TrimmedNonEmptyString,
  authority: LocalContributionAuthority,
  kind: FileContributionKind,
  localName: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
});
export type LocalContribution = typeof LocalContribution.Type;

export const PluginContributionAuthority = Schema.TemplateLiteral([
  "plugin:",
  Schema.toType(TrimmedNonEmptyString),
]);
export type PluginContributionAuthority = typeof PluginContributionAuthority.Type;

export const FileContribution = Schema.Struct({
  id: TrimmedNonEmptyString,
  authority: Schema.Union([LocalContributionAuthority, PluginContributionAuthority]),
  kind: FileContributionKind,
  localName: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
});
export type FileContribution = typeof FileContribution.Type;

const identityKind = (kind: FileContributionKind) => (kind === "mcp-server" ? "mcp" : kind);

export const localContributionId = (
  authority: LocalContributionAuthority,
  kind: FileContributionKind,
  localName: string,
) => `${authority}/${identityKind(kind)}/${localName}`;
