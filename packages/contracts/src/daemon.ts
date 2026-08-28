import * as Schema from "effect/Schema";
import {
  HarnessName,
  IssueTrackerType,
  TrimmedNonEmptyString,
  WorkItemId,
  WorkspaceId,
} from "./base-schemas";
import { LocalContribution } from "./contribution";
import { Claim } from "./coordination";
import { ContributionSettingRow, OperationSettingRow } from "./settings";
import { LifecycleStage, NeedsHumanReason } from "./triage";
import { WorkspaceConcurrency } from "./workspace";

export const DaemonHealth = Schema.Literals(["running", "store-unavailable"]);
export type DaemonHealth = typeof DaemonHealth.Type;

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

export const ActionableItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  stage: LifecycleStage,
  pr: Schema.optionalKey(PrSummary),
});
export type ActionableItem = typeof ActionableItem.Type;

export const ClaimedItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  claim: Claim,
  pr: Schema.optionalKey(PrSummary),
});
export type ClaimedItem = typeof ClaimedItem.Type;

export const BlockedItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  openBlockers: Schema.Natural,
  pr: Schema.optionalKey(PrSummary),
});
export type BlockedItem = typeof BlockedItem.Type;

export const NeedsHumanItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  reason: NeedsHumanReason,
  proposal: Schema.NullOr(TrimmedNonEmptyString),
  url: Schema.NullOr(TrimmedNonEmptyString),
  pr: Schema.optionalKey(PrSummary),
});
export type NeedsHumanItem = typeof NeedsHumanItem.Type;

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
]);
export type PollState = typeof PollState.Type;

export const WorkspaceInfo = Schema.Struct({
  name: WorkspaceId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  checkoutPath: TrimmedNonEmptyString,
  issueTracker: IssueTrackerType,
  harness: HarnessName,
  poll: PollState,
  contributions: Schema.Array(LocalContribution),
  eligible: Schema.Array(ActionableItem),
  claimed: Schema.Array(ClaimedItem),
  blocked: Schema.Array(BlockedItem),
  needsHuman: Schema.Array(NeedsHumanItem),
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
  contributionSettings: Schema.Array(ContributionSettingRow),
  operationSettings: Schema.Array(OperationSettingRow),
});
export type ControlStore = typeof ControlStore.Type;

export class ControlStoreFailure extends Schema.TaggedError<ControlStoreFailure>()("ControlStoreFailure", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class StaleControlStoreWrite extends Schema.TaggedError<StaleControlStoreWrite>()(
  "StaleControlStoreWrite",
  {
    expectedRevision: Schema.Natural,
    actualRevision: Schema.Natural,
  },
) {}

export const DaemonStatus = Schema.Struct({
  health: DaemonHealth,
  startedAtMillis: Schema.Natural,
  uptimeMillis: Schema.Natural,
  scheduler: SchedulerStats,
  workspaces: Schema.Array(WorkspaceInfo),
  failures: Schema.Array(WorkspaceFailureInfo),
});
export type DaemonStatus = typeof DaemonStatus.Type;
