import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkItemId, WorkspaceId } from "./baseSchemas";
import { LifecycleStage } from "./triage";

export const RunId = TrimmedNonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const SessionId = TrimmedNonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Natural),
  outputTokens: Schema.optional(Schema.Natural),
  totalTokens: Schema.optional(Schema.Natural),
});
export type TokenUsage = typeof TokenUsage.Type;

export const RunStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "exhausted",
  "interrupted",
  "crashed",
]);
export type RunStatus = typeof RunStatus.Type;

export const RunEvent = Schema.Struct({
  seq: Schema.Natural,
  type: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  data: Schema.String,
  atMillis: Schema.Natural,
});
export type RunEvent = typeof RunEvent.Type;

export const HarnessEvent = Schema.Struct({
  type: Schema.String,
  name: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(TokenUsage),
  finishReason: Schema.NullOr(Schema.String),
});
export type HarnessEvent = typeof HarnessEvent.Type;

export const RunRecord = Schema.Struct({
  id: RunId,
  workspace: WorkspaceId,
  workItem: WorkItemId,
  stage: LifecycleStage,
  harness: HarnessName,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  session: Schema.NullOr(SessionId),
  usage: Schema.NullOr(TokenUsage),
  status: RunStatus,
  startedAtMillis: Schema.Natural,
  endedAtMillis: Schema.NullOr(Schema.Natural),
});
export type RunRecord = typeof RunRecord.Type;

export const RunSummary = Schema.Struct({
  ...RunRecord.fields,
  eventCount: Schema.Natural,
});
export type RunSummary = typeof RunSummary.Type;

export const RunActivity = Schema.Struct({
  runId: RunId,
  workspace: WorkspaceId,
  workItem: WorkItemId,
  stage: LifecycleStage,
  seq: Schema.Natural,
  atMillis: Schema.Natural,
  event: HarnessEvent,
});
export type RunActivity = typeof RunActivity.Type;
