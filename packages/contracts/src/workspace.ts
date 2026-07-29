import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkspaceId } from "./baseSchemas";

export const WorkSource = Schema.Struct({
  type: TrimmedNonEmptyString,
});
export type WorkSource = typeof WorkSource.Type;

export const HarnessPreferences = Schema.Struct({
  preferred: TrimmedNonEmptyString,
});
export type HarnessPreferences = typeof HarnessPreferences.Type;

export const PlaybookStageConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  prompt: Schema.optional(TrimmedNonEmptyString),
  skill: Schema.optional(TrimmedNonEmptyString),
  harness: Schema.optional(TrimmedNonEmptyString),
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
  name: WorkspaceId,
  checkoutPath: TrimmedNonEmptyString,
  workSource: WorkSource,
  harness: HarnessPreferences,
  playbook: Schema.optional(PlaybookConfig),
});
export type WorkspaceConfig = typeof WorkspaceConfig.Type;
export type WorkspaceConfigInput = Schema.Codec.Encoded<typeof WorkspaceConfig>;
