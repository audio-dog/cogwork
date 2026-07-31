import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkItemId, WorkSourceType, WorkspaceId } from "./baseSchemas";
import { Claim } from "./coordination";
import { BlockReason, LifecycleStage } from "./triage";

export const DaemonHealth = Schema.Literals(["running"]);
export type DaemonHealth = typeof DaemonHealth.Type;

export const ActionableItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  stage: LifecycleStage,
});
export type ActionableItem = typeof ActionableItem.Type;

export const ClaimedItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  claim: Claim,
});
export type ClaimedItem = typeof ClaimedItem.Type;

export const BlockedItem = Schema.Struct({
  id: WorkItemId,
  title: TrimmedNonEmptyString,
  reason: BlockReason,
});
export type BlockedItem = typeof BlockedItem.Type;

export const PollState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("paused"), message: Schema.String }),
]);
export type PollState = typeof PollState.Type;

export const WorkspaceInfo = Schema.Struct({
  name: WorkspaceId,
  checkoutPath: TrimmedNonEmptyString,
  workSource: WorkSourceType,
  harness: HarnessName,
  poll: PollState,
  eligible: Schema.Array(ActionableItem),
  claimed: Schema.Array(ClaimedItem),
  blocked: Schema.Array(BlockedItem),
});
export type WorkspaceInfo = typeof WorkspaceInfo.Type;

export const WorkspaceFailureInfo = Schema.Struct({
  source: TrimmedNonEmptyString,
  message: Schema.String,
});
export type WorkspaceFailureInfo = typeof WorkspaceFailureInfo.Type;

export const WorkspaceLoad = Schema.Struct({
  name: WorkspaceId,
  inFlight: Schema.Natural,
});
export type WorkspaceLoad = typeof WorkspaceLoad.Type;

export const SchedulerStats = Schema.Struct({
  globalInFlight: Schema.Natural,
  globalLimit: Schema.Natural,
  dailyBudgetUsed: Schema.Natural,
  dailyBudgetLimit: Schema.Natural,
  perWorkspace: Schema.Array(WorkspaceLoad),
});
export type SchedulerStats = typeof SchedulerStats.Type;

export const DaemonStatus = Schema.Struct({
  health: DaemonHealth,
  startedAtMillis: Schema.Natural,
  uptimeMillis: Schema.Natural,
  scheduler: SchedulerStats,
  workspaces: Schema.Array(WorkspaceInfo),
  failures: Schema.Array(WorkspaceFailureInfo),
});
export type DaemonStatus = typeof DaemonStatus.Type;
