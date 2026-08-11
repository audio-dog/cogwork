import * as Schema from "effect/Schema";
import { WorkItemId, WorkspaceId } from "./base-schemas";
import { ActionableItem, BlockedItem, ClaimedItem, NeedsHumanItem, SchedulerStats } from "./daemon";
import { RunActivity, RunSummary } from "./run";

export const ClassifiedItem = Schema.TaggedUnion({
  Eligible: ActionableItem.fields,
  Claimed: ClaimedItem.fields,
  Blocked: BlockedItem.fields,
  NeedsHuman: NeedsHumanItem.fields,
});
export type ClassifiedItem = typeof ClassifiedItem.Type;

export const DaemonEvent = Schema.TaggedUnion({
  RunActivity: { activity: RunActivity },
  ItemChanged: { workspace: WorkspaceId, item: ClassifiedItem },
  ItemRemoved: { workspace: WorkspaceId, id: WorkItemId },
  RunChanged: { run: RunSummary },
  SchedulerChanged: { scheduler: SchedulerStats },
});
export type DaemonEvent = typeof DaemonEvent.Type;
