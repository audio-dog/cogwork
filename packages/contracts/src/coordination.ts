import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
    threadTs: Schema.optional(TrimmedNonEmptyString),
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

const keyParsers = new Map<string, (segments: ReadonlyArray<string>) => unknown>([
  ["issue", ([workspace, id]) => ({ _tag: "Issue", workspace, id })],
  ["pull-request", ([workspace, number]) => ({ _tag: "PullRequest", workspace, number: Number(number) })],
  ["granola-note", ([connection, noteId]) => ({ _tag: "GranolaNote", connection, noteId })],
  ["slack-message", ([team, channel, ts]) => ({ _tag: "SlackMessage", team, channel, ts })],
  [
    "slack-conversation",
    ([team, channel, threadTs]) => ({ _tag: "SlackConversation", team, channel, threadTs }),
  ],
  [
    "schedule",
    ([workflow, instant]) => ({ _tag: "ScheduleInstant", workflow, instantMillis: Number(instant) }),
  ],
  [
    "fan-out",
    ([parent, run, position]) => ({ _tag: "FanOutChild", parent, run, position: Number(position) }),
  ],
]);

const decodeKeySegment = Option.liftThrowable(decodeURIComponent);
const decodeRef = Schema.decodeUnknownOption(WorkItemRef);

export const refOfKey = (key: string) => {
  const [kind = "", ...encoded] = key.split(":");
  const parse = keyParsers.get(kind);
  if (parse === undefined) return null;
  return Option.all(encoded.map(decodeKeySegment)).pipe(
    Option.flatMap((segments) => decodeRef(parse(segments))),
    Option.filter((ref) => keyOf(ref) === key),
    Option.getOrNull,
  );
};

const issueRef = (workspace: WorkspaceId, id: string): WorkItemRef =>
  WorkItemRef.cases.Issue.make({ workspace, id: WorkItemId.make(id) });

const urlTail = "(?:[/?#].*)?$";
const workItemReferences: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly ref: (workspace: WorkspaceId, captured: string) => WorkItemRef;
}> = [
  { pattern: /^#([1-9]\d*)$/, ref: (workspace, number) => issueRef(workspace, `#${number}`) },
  { pattern: /^([A-Z][A-Z0-9]*-[1-9]\d*)$/, ref: issueRef },
  {
    pattern: new RegExp(String.raw`^https://github\.com/[^/]+/[^/]+/issues/([1-9]\d*)${urlTail}`),
    ref: (workspace, number) => issueRef(workspace, `#${number}`),
  },
  {
    pattern: new RegExp(String.raw`^https://github\.com/[^/]+/[^/]+/pull/([1-9]\d*)${urlTail}`),
    ref: (workspace, number) => WorkItemRef.cases.PullRequest.make({ workspace, number: Number(number) }),
  },
  {
    pattern: new RegExp(String.raw`^https://linear\.app/[^/]+/issue/([A-Z][A-Z0-9]*-[1-9]\d*)${urlTail}`),
    ref: issueRef,
  },
];

export const parseWorkItemReference = (workspace: WorkspaceId, reference: string) => {
  const text = reference.trim();
  const match = workItemReferences
    .map(({ pattern, ref }) => ({ captured: pattern.exec(text)?.[1], ref }))
    .find(({ captured }) => captured !== undefined);
  if (match?.captured === undefined) {
    return Result.fail(
      `"${text}" is not a work item reference. Use #N, ABC-N, or a GitHub or Linear issue or pull request URL.`,
    );
  }
  return Result.succeed(match.ref(workspace, match.captured));
};

export const OperationKey = Schema.Struct({
  workflow: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
});
export type OperationKey = typeof OperationKey.Type;

export const AttemptReason = TrimmedNonEmptyString.check(Schema.isMaxLength(800));
export type AttemptReason = typeof AttemptReason.Type;

export const Lineage = Schema.Struct({
  root: LineageId,
  parent: Schema.NullOr(LineageId),
  hop: Schema.Natural,
});
export type Lineage = typeof Lineage.Type;

export const Cause = Schema.TaggedUnion({
  Person: {},
  Cogwork: { origin: WorkItemKey, lineage: Lineage },
  Clock: {},
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
  terminal: Schema.optional(Schema.Boolean),
  atMillis: Schema.Natural,
  lineage: Lineage,
  reason: Schema.optional(AttemptReason),
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
  PlanRejected: { reason: TrimmedNonEmptyString, entry: Schema.optional(TrimmedNonEmptyString) },
  WriteFailed: { step: TrimmedNonEmptyString, error: TrimmedNonEmptyString },
  DraftOutcomeUnknown: { step: TrimmedNonEmptyString },
  NoWorkspaceRecognized: { plan: TrimmedNonEmptyString },
  WorktreeBlocked: {
    reason: Schema.Literals(["detached", "diverged", "operation-in-progress", "unsafe-branch"]),
    branch: TrimmedNonEmptyString,
    path: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(Schema.Literals(["merge", "rebase", "cherry-pick"])),
    unmergedPaths: Schema.optional(Schema.Array(Schema.String)),
  },
  AwaitingApproval: {
    plan: TrimmedNonEmptyString,
    digest: TrimmedNonEmptyString,
    revision: TrimmedNonEmptyString,
  },
  HandedToYou: {},
});
export type ParkReason = typeof ParkReason.Type;

export const ParkRecord = Schema.Struct({
  reason: ParkReason,
  operation: Schema.optional(OperationKey),
  atMillis: Schema.Natural,
});
export type ParkRecord = typeof ParkRecord.Type;

export const SourceRevision = Schema.Struct({
  observed: TrimmedNonEmptyString,
  processed: Schema.NullOr(TrimmedNonEmptyString),
});
export type SourceRevision = typeof SourceRevision.Type;
