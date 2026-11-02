import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerType, TrimmedNonEmptyString, WorkItemId, WorkspaceId } from "./base-schemas";
import { Connection } from "./connection";
import { LocalContribution } from "./contribution";
import { HarnessEnablement } from "./harness";
import { PluginInstall } from "./plugin";
import { ContributionSettingRow, OperationSettingRow } from "./settings";
import { OperationNeedKind, WorkspaceConcurrency, WorkspaceRegistration } from "./workspace";

export const DaemonHealth = Schema.Literals(["running", "store-unavailable"]);
export type DaemonHealth = typeof DaemonHealth.Type;

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const processMemoryFields = {
  sampledAtMillis: Schema.Natural,
  heapUsedBytes: Schema.optionalKey(NonNegativeFinite),
  heapLimitBytes: Schema.optionalKey(NonNegativeFinite),
  privateBytes: Schema.optionalKey(NonNegativeFinite),
} as const;

export const DaemonProcessHealthSample = Schema.Struct({
  process: Schema.tag("daemon"),
  ...processMemoryFields,
  eventLoopDelayP99Millis: Schema.optionalKey(NonNegativeFinite),
  eventLoopUtilization: Schema.optionalKey(NonNegativeFinite),
});
export type DaemonProcessHealthSample = typeof DaemonProcessHealthSample.Type;

export const MainProcessHealthSample = Schema.Struct({
  process: Schema.tag("main"),
  ...processMemoryFields,
  eventLoopDelayP99Millis: Schema.optionalKey(NonNegativeFinite),
  eventLoopUtilization: Schema.optionalKey(NonNegativeFinite),
  ipcFramesToRendererPerSecond: Schema.optionalKey(NonNegativeFinite),
  ipcFramesToDaemonPerSecond: Schema.optionalKey(NonNegativeFinite),
});
export type MainProcessHealthSample = typeof MainProcessHealthSample.Type;

export const RendererProcessHealthSample = Schema.Struct({
  process: Schema.tag("renderer"),
  ...processMemoryFields,
  protocolInboxDepth: Schema.optionalKey(Schema.Natural),
  eventsAppliedPerSecond: Schema.optionalKey(NonNegativeFinite),
});
export type RendererProcessHealthSample = typeof RendererProcessHealthSample.Type;

export const DesktopProcessHealthSample = Schema.Union([
  MainProcessHealthSample,
  RendererProcessHealthSample,
]).pipe(Schema.toTaggedUnion("process"));
export type DesktopProcessHealthSample = typeof DesktopProcessHealthSample.Type;

export const ProcessHealthSample = Schema.Union([
  DaemonProcessHealthSample,
  MainProcessHealthSample,
  RendererProcessHealthSample,
]).pipe(Schema.toTaggedUnion("process"));
export type ProcessHealthSample = typeof ProcessHealthSample.Type;

export const PrChecks = Schema.Literals(["passing", "failing", "pending"]);
export type PrChecks = typeof PrChecks.Type;

export const PrReviewStatus = Schema.Literals(["pending", "changes-requested", "ready"]);
export type PrReviewStatus = typeof PrReviewStatus.Type;

export const PrBaseDivergence = Schema.Literals(["conflict", "clean", "none"]);
export type PrBaseDivergence = typeof PrBaseDivergence.Type;

export const PrSummary = Schema.Struct({
  number: Schema.Int,
  url: TrimmedNonEmptyString,
  checks: PrChecks,
  review: PrReviewStatus,
  baseDivergence: PrBaseDivergence,
  waitingSinceMillis: Schema.Finite,
});
export type PrSummary = typeof PrSummary.Type;

export const ReadyToMergeItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  pr: PrSummary,
});
export type ReadyToMergeItem = typeof ReadyToMergeItem.Type;

export const AvailabilityCause = Schema.TaggedUnion({
  UnsatisfiedNeed: {
    need: TrimmedNonEmptyString,
    kind: OperationNeedKind,
    reason: Schema.Literals(["unbound", "off", "unavailable", "not-ready"]),
    contribution: Schema.NullOr(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
  },
  RuntimeHostFactFailed: {
    fact: Schema.Literals(["checkout-path", "harness", "credential"]),
    message: TrimmedNonEmptyString,
  },
  PolicyRefusal: {
    source: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
});
export type AvailabilityCause = typeof AvailabilityCause.Type;

export const OperationAvailability = Schema.Struct({
  operation: TrimmedNonEmptyString,
  available: Schema.Boolean,
  causes: Schema.Array(AvailabilityCause),
});
export type OperationAvailability = typeof OperationAvailability.Type;

export const OperationAvailabilityList = Schema.Array(OperationAvailability).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

export const PollPauseReason = Schema.Literals(["auth", "unavailable", "rate-limited"]);
export type PollPauseReason = typeof PollPauseReason.Type;

export const PollState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("paused"),
    reason: PollPauseReason,
    message: Schema.String,
    retryAtMillis: Schema.NullOr(Schema.Finite),
  }),
]).pipe(Schema.toTaggedUnion("status"));
export type PollState = typeof PollState.Type;

export const WorkspaceInfo = Schema.Struct({
  name: WorkspaceId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  checkoutPath: TrimmedNonEmptyString,
  issueTracker: IssueTrackerType,
  record: WorkspaceRegistration,
  poll: PollState,
  contributions: Schema.Array(LocalContribution),
  availability: OperationAvailabilityList,
  readyToMerge: Schema.Array(ReadyToMergeItem),
});
export type WorkspaceInfo = typeof WorkspaceInfo.Type;

export const WorkspaceFailureInfo = Schema.Struct({
  name: Schema.optional(WorkspaceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  source: TrimmedNonEmptyString,
  message: Schema.String,
});
export type WorkspaceFailureInfo = typeof WorkspaceFailureInfo.Type;

export const maxSchedulerLimit = 1000;
export const SchedulerLimit = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maxSchedulerLimit),
);
export type SchedulerLimit = typeof SchedulerLimit.Type;

export const WorkspaceLoad = Schema.Struct({
  name: WorkspaceId,
  inFlight: Schema.Natural,
  limit: WorkspaceConcurrency,
});
export type WorkspaceLoad = typeof WorkspaceLoad.Type;

export const SchedulingState = Schema.Literals(["running", "paused"]);
export type SchedulingState = typeof SchedulingState.Type;

export const SchedulerStats = Schema.Struct({
  scheduling: SchedulingState,
  globalInFlight: Schema.Natural,
  globalLimit: Schema.Natural,
  perWorkspaceLimit: Schema.Natural,
  dailyBudgetUsed: Schema.Natural,
  dailyBudgetLimit: Schema.Natural,
  perWorkspace: Schema.Array(WorkspaceLoad),
});
export type SchedulerStats = typeof SchedulerStats.Type;

export const DaemonLimitKey = Schema.Literals([
  "global-concurrency",
  "per-workspace-concurrency",
  "daily-budget",
]);
export type DaemonLimitKey = typeof DaemonLimitKey.Type;

export const DaemonLimitUpdate = Schema.Struct({
  key: DaemonLimitKey,
  value: SchedulerLimit,
  expectedRevision: Schema.Natural,
});
export type DaemonLimitUpdate = typeof DaemonLimitUpdate.Type;

export const DaemonLimits = Schema.Struct({
  globalConcurrency: SchedulerLimit,
  perWorkspaceConcurrency: SchedulerLimit,
  dailyBudget: SchedulerLimit,
  revision: Schema.Natural,
});
export type DaemonLimits = typeof DaemonLimits.Type;

export const ControlStore = Schema.Struct({
  daemonLimits: DaemonLimits,
  connections: Schema.Array(Connection),
  harnessSettings: Schema.Array(HarnessEnablement).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  operationSettings: Schema.Array(OperationSettingRow),
  pluginInstalls: Schema.Array(PluginInstall),
  contributionSettings: Schema.Array(ContributionSettingRow),
});
export type ControlStore = typeof ControlStore.Type;

export class ControlStoreFailure extends Schema.TaggedError<ControlStoreFailure>()("ControlStoreFailure", {
  operation: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}) {}

export class StaleControlStoreWrite extends Schema.TaggedError<StaleControlStoreWrite>()(
  "StaleControlStoreWrite",
  {
    expectedRevision: Schema.Natural,
    actualRevision: Schema.Natural,
  },
) {}

export const TriggerSourceHealth = Schema.Struct({
  source: Schema.Literals(["github", "linear", "granola", "slack", "clock"]),
  status: Schema.Literals(["idle", "observing", "failed"]),
  message: Schema.NullOr(Schema.String),
});
export type TriggerSourceHealth = typeof TriggerSourceHealth.Type;

export const DaemonStatus = Schema.Struct({
  health: DaemonHealth,
  startedAtMillis: Schema.Natural,
  uptimeMillis: Schema.Natural,
  eventBusDroppedEvents: Schema.Natural,
  scheduler: SchedulerStats,
  sources: Schema.Array(TriggerSourceHealth).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  workspaces: Schema.Array(WorkspaceInfo),
  failures: Schema.Array(WorkspaceFailureInfo),
});
export type DaemonStatus = typeof DaemonStatus.Type;
