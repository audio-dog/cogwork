import * as Schema from "effect/Schema";
import {
  HarnessName,
  IssueTrackerType,
  TrimmedNonEmptyString,
  WorkItemId,
  WorkspaceId,
} from "./base-schemas";
import {
  ActionableItem,
  BlockedItem,
  ClaimedItem,
  NeedsHumanItem,
  PollState,
  SchedulerStats,
} from "./daemon";
import { RunActivity, RunSummary } from "./run";

export const ClassifiedItem = Schema.TaggedUnion({
  Eligible: ActionableItem.fields,
  Claimed: ClaimedItem.fields,
  Blocked: BlockedItem.fields,
  NeedsHuman: NeedsHumanItem.fields,
});
export type ClassifiedItem = typeof ClassifiedItem.Type;

export const WorkspaceState = Schema.TaggedUnion({
  Registered: {
    name: WorkspaceId,
    checkoutPath: TrimmedNonEmptyString,
    issueTracker: IssueTrackerType,
    harness: HarnessName,
    poll: PollState,
  },
  Failed: {
    source: TrimmedNonEmptyString,
    message: Schema.String,
  },
});
export type WorkspaceState = typeof WorkspaceState.Type;

export const DaemonEvent = Schema.TaggedUnion({
  RunActivity: { activity: RunActivity },
  ItemChanged: { workspace: WorkspaceId, item: ClassifiedItem },
  ItemRemoved: { workspace: WorkspaceId, id: WorkItemId },
  RunChanged: { run: RunSummary },
  WorkspaceChanged: { workspace: WorkspaceState },
  SchedulerChanged: { scheduler: SchedulerStats },
});
export type DaemonEvent = typeof DaemonEvent.Type;
