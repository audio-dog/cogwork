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
  ControlStore,
  NeedsHumanItem,
  PollState,
  SchedulerStats,
} from "./daemon";
import { PluginOverview } from "./plugin";
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
    displayName: Schema.optional(TrimmedNonEmptyString),
    checkoutPath: TrimmedNonEmptyString,
    issueTracker: IssueTrackerType,
    harness: HarnessName,
    poll: PollState,
  },
  Failed: {
    name: Schema.optional(WorkspaceId),
    displayName: Schema.optional(TrimmedNonEmptyString),
    source: TrimmedNonEmptyString,
    message: Schema.String,
  },
});
export type WorkspaceState = typeof WorkspaceState.Type;

export const DaemonEvent = Schema.TaggedUnion({
  SeedEnd: { emittedAtMillis: Schema.Finite },
  RunActivity: { emittedAtMillis: Schema.Finite, activity: RunActivity },
  ItemChanged: { emittedAtMillis: Schema.Finite, workspace: WorkspaceId, item: ClassifiedItem },
  ItemRemoved: { emittedAtMillis: Schema.Finite, workspace: WorkspaceId, id: WorkItemId },
  RunChanged: { emittedAtMillis: Schema.Finite, run: RunSummary },
  WorkspaceChanged: { emittedAtMillis: Schema.Finite, workspace: WorkspaceState },
  ControlStoreChanged: { emittedAtMillis: Schema.Finite, controlStore: ControlStore },
  PluginsChanged: { emittedAtMillis: Schema.Finite, plugins: PluginOverview },
  SchedulerChanged: { emittedAtMillis: Schema.Finite, scheduler: SchedulerStats },
});
export type DaemonEvent = typeof DaemonEvent.Type;
