import * as Schema from "effect/Schema";

export const WorkSource = Schema.Struct({
  type: Schema.String,
});
export type WorkSource = typeof WorkSource.Type;

export const HarnessPreferences = Schema.Struct({
  preferred: Schema.String,
});
export type HarnessPreferences = typeof HarnessPreferences.Type;

export const PlaybookStageConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  prompt: Schema.optional(Schema.String),
  skill: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
});
export type PlaybookStageConfig = typeof PlaybookStageConfig.Type;

export const PlaybookConfig = Schema.Struct({
  triage: Schema.optional(PlaybookStageConfig),
  implement: Schema.optional(PlaybookStageConfig),
  "follow-up": Schema.optional(PlaybookStageConfig),
  verify: Schema.optional(PlaybookStageConfig),
});
export type PlaybookConfig = typeof PlaybookConfig.Type;

export const WorkspaceConfig = Schema.Struct({
  name: Schema.String,
  checkoutPath: Schema.String,
  workSource: WorkSource,
  harness: HarnessPreferences,
  playbook: Schema.optional(PlaybookConfig),
});
export type WorkspaceConfig = typeof WorkspaceConfig.Type;

export const defineWorkspace = (config: WorkspaceConfig) => config;
