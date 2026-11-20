import {
  keyOf,
  LineageId,
  localOwnerId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { clockEntries } from "./clock-source";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import {
  IssueTracker,
  type IssueTrackerError,
  makeEmpty as makeEmptyIssueTracker,
  type TrackerItem,
} from "./issue-tracker";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { makeScriptedSource } from "./scripted-source";
import { make } from "./trigger-observation";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservationStore,
  type TriggerObservationStoreService,
} from "./trigger-observation-store";
import {
  type SourceFailure,
  type TriggerEvent,
  type TriggerSource,
  type TriggerSourceId,
  TriggerSources,
  type TriggerSubscription,
} from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

export const workflowId = Schema.decodeSync(WorkflowId)("daily-summary");
export const otherWorkflowId = Schema.decodeSync(WorkflowId)("other-workflow");
export const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
export const entry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
export const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
export const scheduleParameters = [
  { id: "hour", value: "0" },
  { id: "minute", value: "0" },
  { id: "zone", value: "UTC" },
];
export const scheduledInstant = Date.UTC(2025, 0, 1);
export const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [
    {
      id: triggerId,
      entry,
      parameters: scheduleParameters,
      start: Schema.decodeSync(WorkflowNodeId)("summarize"),
    },
  ],
  operations: [],
});

export const record = (enabled: boolean, publishedCopy = document): WorkflowRecord => ({
  id: workflowId,
  principal: localOwnerId,
  workingCopy: publishedCopy,
  workingRevision: 1,
  publishedCopy,
  publishedRevision: 1,
  enabled,
  diagnostics: [],
  readiness: [],
});

export const workItem = {
  _tag: "ScheduleInstant",
  workflow: workflowId,
  instantMillis: scheduledInstant,
} as const;
export const event = {
  key: workItem,
  revision: String(scheduledInstant),
  cause: { _tag: "Unknown" },
  atMillis: scheduledInstant,
  entry,
  workspace: null,
} as const;
export const lineage = { root: Schema.decodeSync(LineageId)(keyOf(workItem)), parent: null, hop: 0 } as const;

export const subscription: TriggerSubscription = {
  workflow: workflowId,
  trigger: triggerId,
  operation: Schema.decodeSync(WorkflowNodeId)("summarize"),
  entry,
  parameters: scheduleParameters,
  filters: [],
  workspaces: [],
  catchUp: { since: 0 },
};
export const selectedWorkspaceId = Schema.decodeSync(WorkspaceId)("selected");
export const selectedWorkspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: selectedWorkspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/selected",
    issueTracker: { type: "github", assigneeAllowlist: ["owner"] },
  }),
};
export const ungatedWorkspace: RegisteredWorkspace = {
  ...selectedWorkspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    id: selectedWorkspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/selected",
    issueTracker: { type: "github" },
  }),
};
export const selectedDocument = Schema.decodeSync(WorkflowDocument)({
  ...document,
  workspaces: { _tag: "Listed", workspaces: [selectedWorkspaceId] },
});
export const selectedIssueId = Schema.decodeSync(WorkItemId)("#1");
export const nextSelectedIssueId = Schema.decodeSync(WorkItemId)("#2");
export const unassignedIssueId = Schema.decodeSync(WorkItemId)("#3");
export const selectedEvent = {
  ...event,
  key: { _tag: "Issue", workspace: selectedWorkspaceId, id: selectedIssueId },
  workspace: selectedWorkspaceId,
  revision: "issue-1",
} as const;
export const selectedTrackerItem: TrackerItem = {
  id: selectedIssueId,
  title: "Selected issue",
  url: "https://github.com/acme/example/issues/1",
  assignees: ["owner"],
  openBlockers: 0,
  priority: "medium",
};

export const makeWorkspaceObservation = Effect.fn("TriggerObservationTest.makeWorkspaceObservation")(
  function* (
    options: {
      readonly assignees?: (itemId: WorkItemId) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
      readonly observedItems?: ReadonlyArray<TrackerItem>;
      readonly workspace?: RegisteredWorkspace;
      readonly store?: TriggerObservationStoreService;
      readonly document?: WorkflowDocument;
      readonly source?: { readonly id: TriggerSourceId; readonly entries: TriggerSource["entries"] };
    } = {},
  ) {
    const current = yield* Ref.make(record(true, options.document ?? selectedDocument));
    const processed = yield* Ref.make<string | null>(null);
    const observed = yield* Ref.make(0);
    const sourceRevision = yield* Ref.make<string | null>(null);
    const assigneeReads = yield* Ref.make<ReadonlyArray<WorkItemId>>([]);
    const scripted = yield* makeScriptedSource(
      options.source?.id ?? "clock",
      options.source?.entries ?? clockEntries,
    );
    const store = options.store ?? (yield* makeMemoryTriggerObservationStore);
    const bus = yield* makeDaemonEventBus;
    const readAssignees = options.assignees ?? (() => Effect.succeed(["owner"]));
    const tracker = {
      ...(yield* makeEmptyIssueTracker),
      observe: () =>
        options.observedItems === undefined
          ? Effect.die("the assignee gate read the whole Workspace")
          : Effect.succeed(options.observedItems),
      assignees: (_workspace: WorkspaceIssueTrackerBinding, itemId: WorkItemId) =>
        Ref.update(assigneeReads, (reads) => [...reads, itemId]).pipe(Effect.andThen(readAssignees(itemId))),
    };
    const coordination = coordinationService(processed, observed, sourceRevision);
    const observation = yield* make.pipe(
      Effect.provideService(Workflows, workflowService(current)),
      Effect.provideService(Coordination, coordination),
      Effect.provideService(TriggerSources, [scripted.source]),
      Effect.provideService(TriggerObservationStore, store),
      Effect.provideService(DaemonEventBus, bus),
      Effect.provideService(IssueTracker, tracker),
      Effect.provideService(
        WorkspaceRegistry,
        readOnlyRegistry({ workspaces: [options.workspace ?? selectedWorkspace], failures: [] }),
      ),
    );
    yield* Effect.yieldNow;
    yield* observation.refresh;
    return { observation, scripted, assigneeReads, observed, coordination, store };
  },
);

export const observeLineage = Effect.fn("TriggerObservationTest.observeLineage")(function* (
  cause: TriggerEvent["cause"],
) {
  const { observation, scripted } = yield* makeWorkspaceObservation();
  const changed = yield* observation.changes.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* scripted.emit({ ...selectedEvent, cause });
  const admitted = yield* Fiber.join(changed);
  return admitted[0]?.lineage;
});

export const granolaEntry = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
export const granolaEditedEntry = Schema.decodeSync(WorkflowCatalogKey)("granola.note-edited");
export const granolaTriggers = ["first", "second"].map((id) => ({
  id: Schema.decodeSync(WorkflowNodeId)(id),
  entry: granolaEntry,
  parameters: [],
  start: Schema.decodeSync(WorkflowNodeId)(`${id}-operation`),
}));
export const granolaDocument = Schema.decodeSync(WorkflowDocument)({
  name: "Granola",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: granolaTriggers,
  operations: [],
});

export const workflowService = (current: Ref.Ref<WorkflowRecord>): WorkflowsService => ({
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.map(Ref.get(current), (workflow) => ({ workflows: [workflow], unreadable: [] })),
  get: () => Effect.die("unused"),
  validate: () => Effect.succeed([]),
  catalog: Effect.die("unused"),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
});

export const coordinationService = (
  processed: Ref.Ref<string | null>,
  observed: Ref.Ref<number>,
  sourceRevision: Ref.Ref<string | null>,
): CoordinationService => ({
  fold,
  read: () =>
    Effect.map(Effect.all([Ref.get(processed), Ref.get(sourceRevision)]), ([revision, observedRevision]) =>
      fold(
        {
          claim: null,
          attempts: [],
          handbacks: [],
          parks: [],
          revision: { observed: observedRevision ?? event.revision, processed: revision },
        },
        "cogwork",
      ),
    ),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: (_ref, revision) =>
    Ref.update(observed, (count) => count + 1).pipe(
      Effect.andThen(
        Ref.modify(
          sourceRevision,
          (current) => [current === revision ? "redelivered" : "moved", revision] as const,
        ),
      ),
    ),
  markProcessed: (_ref, revision) => Ref.set(processed, revision),
});

export const sourceFailingOnce = (starts: Ref.Ref<number>, failure: SourceFailure): TriggerSource => ({
  id: "clock",
  entries: clockEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  observe: (subscriptions) =>
    subscriptions.length === 0
      ? Stream.empty
      : Stream.unwrap(
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? Stream.fail(failure) : Stream.never)),
          ),
        ),
});
