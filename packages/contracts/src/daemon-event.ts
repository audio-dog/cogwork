import * as Schema from "effect/Schema";

import { IssueTrackerType, TrimmedNonEmptyString, WorkflowId, WorkItemId, WorkspaceId } from "./base-schemas";
import { ConnectionOverview } from "./connection";
import { LocalContribution } from "./contribution";
import { ControlStore, ReadyToMergeItem, SchedulerStats } from "./daemon";
import { HarnessReadiness } from "./harness";
import { PluginOverview } from "./plugin";
import { RunActivity, RunSubject, RunSummary } from "./run";
import { WorkflowRecord } from "./workflow-catalog";
import { WorkspaceRecord } from "./workspace";

export const ReadModelItem = Schema.TaggedUnion({
  ReadyToMerge: ReadyToMergeItem.fields,
});
export type ReadModelItem = typeof ReadModelItem.Type;

export const WorkspaceState = Schema.TaggedUnion({
  Registered: {
    id: WorkspaceId,
    displayName: TrimmedNonEmptyString,
    checkoutPath: TrimmedNonEmptyString,
    issueTracker: IssueTrackerType,
    record: WorkspaceRecord,
    contributions: Schema.Array(LocalContribution),
  },
  Failed: {
    id: Schema.optional(WorkspaceId),
    displayName: Schema.optional(TrimmedNonEmptyString),
    source: TrimmedNonEmptyString,
    message: Schema.String,
  },
});
export type WorkspaceState = typeof WorkspaceState.Type;

export const QueuedItem = Schema.Struct({
  place: Schema.Int.check(Schema.isGreaterThan(0)),
  workspace: WorkspaceId,
  workItem: WorkItemId,
  subject: Schema.optionalKey(RunSubject),
  workflow: WorkflowId,
  operation: TrimmedNonEmptyString,
});
export type QueuedItem = typeof QueuedItem.Type;

export const SchedulerQueue = Schema.Struct({ queued: Schema.Array(QueuedItem) });
export type SchedulerQueue = typeof SchedulerQueue.Type;

export const DaemonEvent = Schema.TaggedUnion({
  SeedEnd: { emittedAtMillis: Schema.Finite },
  RunActivity: { emittedAtMillis: Schema.Finite, activity: RunActivity },
  ItemChanged: { emittedAtMillis: Schema.Finite, workspace: WorkspaceId, item: ReadModelItem },
  ItemRemoved: { emittedAtMillis: Schema.Finite, workspace: WorkspaceId, id: WorkItemId },
  RunChanged: { emittedAtMillis: Schema.Finite, run: RunSummary },
  WorkspaceChanged: { emittedAtMillis: Schema.Finite, workspace: WorkspaceState },
  WorkspaceRemoved: { emittedAtMillis: Schema.Finite, workspace: WorkspaceId },
  ControlStoreChanged: { emittedAtMillis: Schema.Finite, controlStore: ControlStore },
  PluginsChanged: {
    emittedAtMillis: Schema.Finite,
    plugins: PluginOverview,
    notices: Schema.Array(TrimmedNonEmptyString),
  },
  ConnectionsChanged: {
    emittedAtMillis: Schema.Finite,
    connections: ConnectionOverview,
    danglingWorkspaces: Schema.Array(WorkspaceId),
  },
  HarnessesChanged: { emittedAtMillis: Schema.Finite, readiness: HarnessReadiness },
  SchedulerChanged: { emittedAtMillis: Schema.Finite, scheduler: SchedulerStats },
  QueueChanged: { emittedAtMillis: Schema.Finite, queue: SchedulerQueue },
  WorkflowChanged: { emittedAtMillis: Schema.Finite, workflow: WorkflowRecord },
  WorkflowDeleted: { emittedAtMillis: Schema.Finite, id: WorkflowId },
});
export type DaemonEvent = typeof DaemonEvent.Type;
