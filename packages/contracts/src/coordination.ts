import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkItemId, WorkspaceId } from "./base-schemas";
import { ConnectionId } from "./connection";
import { RunId } from "./run";

export const WorkItemKey = TrimmedNonEmptyString.pipe(Schema.brand("WorkItemKey"));
export type WorkItemKey = typeof WorkItemKey.Type;

export const LineageId = TrimmedNonEmptyString.pipe(Schema.brand("LineageId"));
export type LineageId = typeof LineageId.Type;

export const WorkItemRef = Schema.TaggedUnion({
  Issue: { workspace: WorkspaceId, id: WorkItemId },
  PullRequest: { workspace: WorkspaceId, number: Schema.Int.check(Schema.isGreaterThan(0)) },
  GranolaNote: { connection: ConnectionId, noteId: TrimmedNonEmptyString },
  SlackMessage: {
    team: TrimmedNonEmptyString,
    channel: TrimmedNonEmptyString,
    ts: TrimmedNonEmptyString,
  },
  SlackConversation: {
    team: TrimmedNonEmptyString,
    channel: TrimmedNonEmptyString,
    threadTs: TrimmedNonEmptyString,
  },
  ScheduleInstant: { workflow: TrimmedNonEmptyString, instantMillis: Schema.Natural },
  FanOutChild: { parent: WorkItemKey, run: RunId, position: Schema.Natural },
});
export type WorkItemRef = typeof WorkItemRef.Type;

const segment = (value: string | number) => encodeURIComponent(String(value));
const keyProducers = {
  Issue: (ref: Extract<WorkItemRef, { readonly _tag: "Issue" }>) =>
    `issue:${segment(ref.workspace)}:${segment(ref.id)}`,
  PullRequest: (ref: Extract<WorkItemRef, { readonly _tag: "PullRequest" }>) =>
    `pull-request:${segment(ref.workspace)}:${ref.number}`,
  GranolaNote: (ref: Extract<WorkItemRef, { readonly _tag: "GranolaNote" }>) =>
    `granola-note:${segment(ref.connection)}:${segment(ref.noteId)}`,
  SlackMessage: (ref: Extract<WorkItemRef, { readonly _tag: "SlackMessage" }>) =>
    `slack-message:${segment(ref.team)}:${segment(ref.channel)}:${segment(ref.ts)}`,
  SlackConversation: (ref: Extract<WorkItemRef, { readonly _tag: "SlackConversation" }>) =>
    `slack-conversation:${segment(ref.team)}:${segment(ref.channel)}:${segment(ref.threadTs)}`,
  ScheduleInstant: (ref: Extract<WorkItemRef, { readonly _tag: "ScheduleInstant" }>) =>
    `schedule:${segment(ref.workflow)}:${ref.instantMillis}`,
  FanOutChild: (ref: Extract<WorkItemRef, { readonly _tag: "FanOutChild" }>) =>
    `fan-out:${segment(ref.parent)}:${segment(ref.run)}:${ref.position}`,
} satisfies {
  [Tag in WorkItemRef["_tag"]]: (ref: Extract<WorkItemRef, { readonly _tag: Tag }>) => string;
};

export const keyOf = (ref: WorkItemRef) => WorkItemKey.make(keyProducers[ref._tag](ref as never));

export const OperationKey = Schema.Struct({
  workflow: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
});
export type OperationKey = typeof OperationKey.Type;

export const codingOperation = (operation: string) => ({ workflow: "coding", operation });

export const Lineage = Schema.Struct({
  root: LineageId,
  parent: Schema.NullOr(LineageId),
  hop: Schema.Natural,
});
export type Lineage = typeof Lineage.Type;

export const Cause = Schema.TaggedUnion({
  Person: {},
  Cogwork: { origin: WorkItemKey },
  Unknown: {},
});
export type Cause = typeof Cause.Type;

export const Claim = Schema.Struct({
  by: TrimmedNonEmptyString,
  claimedAtMillis: Schema.Natural,
  operation: OperationKey,
  lineage: Lineage,
});
export type Claim = typeof Claim.Type;

export const AttemptOutcome = Schema.Literals(["succeeded", "failed", "abandoned"]);
export type AttemptOutcome = typeof AttemptOutcome.Type;

export const AttemptRecord = Schema.Struct({
  operation: OperationKey,
  outcome: AttemptOutcome,
  atMillis: Schema.Natural,
  lineage: Lineage,
});
export type AttemptRecord = typeof AttemptRecord.Type;

export const HandbackRecord = Schema.Struct({
  by: TrimmedNonEmptyString,
  atMillis: Schema.Natural,
  note: Schema.NullOr(Schema.String),
});
export type HandbackRecord = typeof HandbackRecord.Type;

export const ParkReason = Schema.TaggedUnion({
  Stuck: { summary: TrimmedNonEmptyString },
  Exhausted: { reason: TrimmedNonEmptyString },
  HopCap: {},
  MissingOperation: {},
  WriteFailed: { step: TrimmedNonEmptyString, error: TrimmedNonEmptyString },
  NoWorkspaceRecognized: { plan: TrimmedNonEmptyString },
  AwaitingApproval: {
    plan: TrimmedNonEmptyString,
    digest: TrimmedNonEmptyString,
    revision: TrimmedNonEmptyString,
  },
  HandedToYou: {},
});
export type ParkReason = typeof ParkReason.Type;

export const ParkRecord = Schema.Struct({ reason: ParkReason, atMillis: Schema.Natural });
export type ParkRecord = typeof ParkRecord.Type;

export const SourceRevision = Schema.Struct({
  observed: TrimmedNonEmptyString,
  processed: Schema.NullOr(TrimmedNonEmptyString),
});
export type SourceRevision = typeof SourceRevision.Type;
