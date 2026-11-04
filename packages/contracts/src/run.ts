import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AgUiCorrelation, AgUiEvent } from "./ag-ui";
import {
  BranchName,
  HarnessName,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkItemId,
  WorkspaceId,
} from "./base-schemas";

export const RunId = TrimmedNonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const SessionId = TrimmedNonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const SessionKind = Schema.Literals(["owned-transcript", "opaque-handle"]);
export type SessionKind = typeof SessionKind.Type;

const SessionFields = {
  id: SessionId,
  workspace: WorkspaceId,
  harness: HarnessName,
  createdAtMillis: Schema.Natural,
};

export const OwnedTranscriptSession = Schema.Struct({
  kind: Schema.Literal("owned-transcript"),
  ...SessionFields,
});
export type OwnedTranscriptSession = typeof OwnedTranscriptSession.Type;

export const OpaqueHandleSession = Schema.Struct({
  kind: Schema.Literal("opaque-handle"),
  ...SessionFields,
  handle: Schema.NullOr(TrimmedNonEmptyString),
});
export type OpaqueHandleSession = typeof OpaqueHandleSession.Type;

export const Session = Schema.Union([OwnedTranscriptSession, OpaqueHandleSession]);
export type Session = typeof Session.Type;

export const sessionHandle = (session: Session | null) =>
  session?.kind === "opaque-handle" ? session.handle : null;

// Owned-transcript always resumes from the run ledger; opaque-handle only once
// the harness has handed back a handle to pick the conversation up by.
export const sessionResumable = (session: Session | null) =>
  session?.kind === "owned-transcript" || sessionHandle(session) !== null;

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Natural),
  outputTokens: Schema.optional(Schema.Natural),
  totalTokens: Schema.optional(Schema.Natural),
  estimated: Schema.optional(Schema.Boolean),
});
export type TokenUsage = typeof TokenUsage.Type;

export const RunStatus = Schema.Literals([
  "running",
  "succeeded",
  "declined",
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

export const RunSubject = Schema.Struct({
  title: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type RunSubject = typeof RunSubject.Type;

export const RunRecord = Schema.Struct({
  id: RunId,
  workspace: WorkspaceId,
  workItem: WorkItemId,
  subject: Schema.optionalKey(RunSubject),
  workflow: Schema.optionalKey(WorkflowId),
  operation: TrimmedNonEmptyString,
  harness: HarnessName,
  branch: Schema.NullOr(BranchName),
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
  eventsPrunedAtMillis: Schema.NullOr(Schema.Natural).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
});
export type RunSummary = typeof RunSummary.Type;

export const RunHistory = Schema.Struct({
  events: Schema.Array(RunEvent),
  eventsPrunedAtMillis: Schema.NullOr(Schema.Natural),
});
export type RunHistory = typeof RunHistory.Type;

export const RunActivity = Schema.Struct({
  runId: RunId,
  workspace: WorkspaceId,
  workItem: WorkItemId,
  operation: TrimmedNonEmptyString,
  seq: Schema.Natural,
  atMillis: Schema.Natural,
  correlation: AgUiCorrelation,
  event: AgUiEvent,
});
export type RunActivity = typeof RunActivity.Type;
