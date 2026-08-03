import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkSourceType, WorkspaceId } from "./baseSchemas";

export const TriageRoleLabels = Schema.Struct({
  "needs-triage": Schema.optional(TrimmedNonEmptyString),
  "ready-for-agent": Schema.optional(TrimmedNonEmptyString),
  "needs-info": Schema.optional(TrimmedNonEmptyString),
  "ready-for-human": Schema.optional(TrimmedNonEmptyString),
  wontfix: Schema.optional(TrimmedNonEmptyString),
});
export type TriageRoleLabels = typeof TriageRoleLabels.Type;

export const OAuthAppConfig = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  redirectPort: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(65536))),
});
export type OAuthAppConfig = typeof OAuthAppConfig.Type;

export const WorkSourceConfig = Schema.Struct({
  type: WorkSourceType,
  repo: Schema.optional(TrimmedNonEmptyString),
  team: Schema.optional(TrimmedNonEmptyString),
  organization: Schema.optional(TrimmedNonEmptyString),
  tokenEnv: Schema.optional(TrimmedNonEmptyString),
  oauth: Schema.optional(OAuthAppConfig),
  botLogin: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  roleLabels: Schema.optional(TriageRoleLabels),
});
export type WorkSourceConfig = typeof WorkSourceConfig.Type;

export const HarnessPreferences = Schema.Struct({
  preferred: HarnessName,
});
export type HarnessPreferences = typeof HarnessPreferences.Type;

export const PlaybookStageConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  prompt: Schema.optional(TrimmedNonEmptyString),
  skill: Schema.optional(TrimmedNonEmptyString),
  harness: Schema.optional(HarnessName),
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  resumeMaxAgeMillis: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  resumeMaxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type PlaybookStageConfig = typeof PlaybookStageConfig.Type;

export const PlaybookConfig = Schema.Struct({
  triage: Schema.optional(PlaybookStageConfig),
  implement: Schema.optional(PlaybookStageConfig),
  "follow-up": Schema.optional(PlaybookStageConfig),
  verify: Schema.optional(PlaybookStageConfig),
});
export type PlaybookConfig = typeof PlaybookConfig.Type;

export const WorktreeConfig = Schema.Struct({
  root: Schema.optional(TrimmedNonEmptyString),
  remote: Schema.optional(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  linkEnvFiles: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  setup: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reapAfterMillis: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type WorktreeConfig = typeof WorktreeConfig.Type;

export const WorkspaceConfig = Schema.Struct({
  name: WorkspaceId,
  checkoutPath: TrimmedNonEmptyString,
  workSource: WorkSourceConfig,
  harness: HarnessPreferences,
  playbook: Schema.optional(PlaybookConfig),
  worktrees: Schema.optional(WorktreeConfig),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type WorkspaceConfig = typeof WorkspaceConfig.Type;
export type WorkspaceConfigInput = Schema.Codec.Encoded<typeof WorkspaceConfig>;
