import {
  AttemptRecord,
  connectionIdOf,
  keyOf,
  LineageId,
  localOwnerId,
  ParkRecord,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
  WorkItemId,
  type WorkItemRef,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { clockEntries } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { makeControlStoreCoordination } from "./coordination-control-store";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { granolaEntries } from "./granola-source";
import {
  IssueTracker,
  IssueTrackerError,
  makeEmpty as makeEmptyIssueTracker,
  type TrackerItem,
} from "./issue-tracker";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import { emptyRegistry, readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { makeScriptedSource } from "./scripted-source";
import {
  make,
  makeControlStoreTriggerObservationStore,
  makeMemoryTriggerObservationStore,
  matchTriggerEvent,
  type TriggerAdmission,
  TriggerObservationStore,
  TriggerObservationStoreError,
  type TriggerObservationStoreService,
} from "./trigger-observation";
import {
  SourceFailure,
  type TriggerEvent,
  type TriggerSource,
  TriggerSources,
  type TriggerSubscription,
} from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

const workflowId = Schema.decodeSync(WorkflowId)("daily-summary");
const otherWorkflowId = Schema.decodeSync(WorkflowId)("other-workflow");
const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
const entry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const scheduleParameters = [
  { id: "hour", value: "0" },
  { id: "minute", value: "0" },
  { id: "zone", value: "UTC" },
];
const scheduledInstant = Date.UTC(2025, 0, 1);
const document = Schema.decodeSync(WorkflowDocument)({
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

const record = (enabled: boolean, publishedCopy = document): WorkflowRecord => ({
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

const workItem = { _tag: "ScheduleInstant", workflow: workflowId, instantMillis: scheduledInstant } as const;
const event = {
  key: workItem,
  revision: String(scheduledInstant),
  cause: { _tag: "Unknown" },
  atMillis: scheduledInstant,
  entry,
  workspace: null,
} as const;
const lineage = { root: Schema.decodeSync(LineageId)(keyOf(workItem)), parent: null, hop: 0 } as const;

const subscription: TriggerSubscription = {
  workflow: workflowId,
  trigger: triggerId,
  operation: Schema.decodeSync(WorkflowNodeId)("summarize"),
  entry,
  parameters: scheduleParameters,
  workspaces: [],
  catchUp: { since: 0 },
};
const selectedWorkspaceId = Schema.decodeSync(WorkspaceId)("selected");
const selectedWorkspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: selectedWorkspaceId,
    checkoutPath: "/repos/selected",
    issueTracker: { type: "github", assigneeAllowlist: ["owner"] },
  }),
};
const selectedDocument = Schema.decodeSync(WorkflowDocument)({
  ...document,
  workspaces: { _tag: "Listed", workspaces: [selectedWorkspaceId] },
});
const selectedIssueId = Schema.decodeSync(WorkItemId)("#1");
const nextSelectedIssueId = Schema.decodeSync(WorkItemId)("#2");
const selectedEvent = {
  ...event,
  key: { _tag: "Issue", workspace: selectedWorkspaceId, id: selectedIssueId },
  workspace: selectedWorkspaceId,
  revision: "issue-1",
} as const;
const selectedTrackerItem: TrackerItem = {
  claimHeld: false,
  claim: null,
  claimedByUs: false,
  attempts: [],
  handback: null,
  id: selectedIssueId,
  title: "Selected issue",
  url: "https://github.com/acme/example/issues/1",
  roles: [],
  assignees: ["owner"],
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  followUp: null,
};

const makeWorkspaceObservation = Effect.fn("TriggerObservationTest.makeWorkspaceObservation")(function* (
  options: {
    readonly observedItems?: ReadonlyArray<TrackerItem>;
    readonly exactAssignees?: (itemId: WorkItemId) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
    readonly store?: TriggerObservationStoreService;
  } = {},
) {
  const current = yield* Ref.make(record(true, selectedDocument));
  const processed = yield* Ref.make<string | null>(null);
  const observed = yield* Ref.make(0);
  const sourceRevision = yield* Ref.make<string | null>(null);
  const trackerCalls = yield* Ref.make(0);
  const exactAssigneeCalls = yield* Ref.make(0);
  const scripted = yield* makeScriptedSource("clock", clockEntries);
  const store = options.store ?? (yield* makeMemoryTriggerObservationStore);
  const bus = yield* makeDaemonEventBus;
  const emptyTracker = yield* makeEmptyIssueTracker;
  const exactAssignees = options.exactAssignees;
  const tracker = {
    ...emptyTracker,
    observe: () =>
      Ref.update(trackerCalls, (count) => count + 1).pipe(
        Effect.map(() => options.observedItems ?? [selectedTrackerItem]),
      ),
    ...(exactAssignees === undefined
      ? {}
      : {
          assignees: (_workspace: WorkspaceIssueTrackerBinding, itemId: WorkItemId) =>
            Ref.update(exactAssigneeCalls, (count) => count + 1).pipe(Effect.andThen(exactAssignees(itemId))),
        }),
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
      readOnlyRegistry({ workspaces: [selectedWorkspace], failures: [] }),
    ),
  );
  yield* Effect.yieldNow;
  yield* observation.refresh;
  return { observation, scripted, trackerCalls, exactAssigneeCalls, observed, coordination, store };
});

const observeLineage = Effect.fn("TriggerObservationTest.observeLineage")(function* (
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

const granolaEntry = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
const granolaEditedEntry = Schema.decodeSync(WorkflowCatalogKey)("granola.note-edited");
const granolaTriggers = ["first", "second"].map((id) => ({
  id: Schema.decodeSync(WorkflowNodeId)(id),
  entry: granolaEntry,
  parameters: [],
  start: Schema.decodeSync(WorkflowNodeId)(`${id}-operation`),
}));
const granolaDocument = Schema.decodeSync(WorkflowDocument)({
  name: "Granola",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: granolaTriggers,
  operations: [],
});

const workflowService = (current: Ref.Ref<WorkflowRecord>): WorkflowsService => ({
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

const coordinationService = (
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

const sourceFailingOnce = (starts: Ref.Ref<number>, failure: SourceFailure): TriggerSource => ({
  id: "clock",
  entries: clockEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  listOptions: () => Effect.succeed([]),
  observe: (subscriptions) =>
    subscriptions.length === 0
      ? Stream.empty
      : Stream.unwrap(
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? Stream.fail(failure) : Stream.never)),
          ),
        ),
});

const exerciseFailedLastAdmissionFinish = (storePath: string, admission: TriggerAdmission) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* makeControlStoreTriggerObservationStore;
    const coordination = yield* makeControlStoreCoordination;
    yield* coordination.observe(event.key, event.revision, event.cause);
    yield* store.putAll([admission]);
    yield* sql`
      CREATE TRIGGER fail_trigger_admission_finish
      BEFORE UPDATE OF processed ON trigger_admissions
      WHEN NEW.processed = 1
      BEGIN
        SELECT RAISE(ABORT, 'finish failed');
      END
    `;
    const failure = yield* Effect.flip(
      store.complete(admission, coordination.markProcessed(event.key, event.revision)),
    );
    const failedView = yield* coordination.read(event.key);
    const pending = yield* store.admissions;
    yield* sql`DROP TRIGGER fail_trigger_admission_finish`;
    yield* store.complete(admission, coordination.markProcessed(event.key, event.revision));
    const completedView = yield* coordination.read(event.key);
    const remaining = yield* store.admissions;
    return { failure, failedView, pending, completedView, remaining };
  }).pipe(Effect.provide(bootControlStoreLayer(storePath)));

const exerciseFailedFanOutFinish = Effect.fn("TriggerObservationTest.exerciseFailedFanOutFinish")(function* (
  parent: TriggerAdmission,
  child: TriggerAdmission,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeControlStoreTriggerObservationStore;
  yield* store.putAll([parent]);
  yield* sql`
      CREATE TRIGGER fail_fan_out_parent_finish
      BEFORE UPDATE OF processed ON trigger_admissions
      WHEN NEW.processed = 1
      BEGIN
        SELECT RAISE(ABORT, 'finish failed');
      END
    `;
  const failure = yield* Effect.flip(store.fanOut(parent, [child], Effect.void));
  return { failure, pending: yield* store.admissions };
});

describe("TriggerObservation", () => {
  it("matches a schedule event to one Trigger with the scheduled parameters", () => {
    const other = { ...subscription, workflow: Schema.decodeSync(WorkflowId)("other") };
    const later = {
      ...subscription,
      trigger: Schema.decodeSync(WorkflowNodeId)("later"),
      operation: Schema.decodeSync(WorkflowNodeId)("later-operation"),
      parameters: scheduleParameters.map((parameter) =>
        parameter.id === "hour" ? { ...parameter, value: "1" } : parameter,
      ),
    };

    assert.deepStrictEqual(matchTriggerEvent([later, subscription, other], event), [subscription]);
  });

  it("does not treat an empty Workspace selection as every Workspace", () => {
    const workspaceEvent = {
      ...event,
      key: {
        _tag: "Issue" as const,
        workspace: Schema.decodeSync(WorkspaceId)("selected"),
        id: Schema.decodeSync(WorkItemId)("#1"),
      },
      workspace: Schema.decodeSync(WorkspaceId)("selected"),
    };

    assert.deepStrictEqual(matchTriggerEvent([subscription], workspaceEvent), []);
  });

  it("matches a source event only to the Trigger whose parameters produced it", () => {
    const selected = {
      ...subscription,
      entry: Schema.decodeSync(WorkflowCatalogKey)("slack.i-am-mentioned"),
      parameters: [{ id: "channel", value: "C123" }],
    };
    const other = { ...selected, parameters: [{ id: "channel", value: "C456" }] };
    const slackEvent = {
      ...event,
      key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" } as const,
      entry: selected.entry,
      parameters: selected.parameters,
    };

    assert.deepStrictEqual(matchTriggerEvent([other, selected], slackEvent), [selected]);
  });

  it.effect("admits every matching Workflow for one source revision", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* observation.refresh;
      yield* Effect.yieldNow;
      const changes = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      });
      yield* TestClock.adjust("1 second");
      const admitted = yield* Fiber.join(changes);

      assert.isTrue(Option.isSome(admitted));
      if (Option.isNone(admitted)) return;
      assert.deepStrictEqual(
        admitted.value.map(({ subscription }) => subscription.workflow).toSorted(),
        [workflowId, otherWorkflowId].toSorted(),
      );
      assert.lengthOf(yield* observation.eligible, 2);
      assert.strictEqual(yield* Ref.get(observed), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("starts person lineages and extends Cogwork lineages", () =>
    Effect.gen(function* () {
      const inheritedRoot = yield* Schema.decodeEffect(LineageId)("issue:root");
      const parent = keyOf(workItem);
      const cases = [
        {
          cause: { _tag: "Person" } as const,
          expected: {
            root: yield* Schema.decodeEffect(LineageId)(keyOf(selectedEvent.key)),
            parent: null,
            hop: 0,
          },
        },
        {
          cause: {
            _tag: "Cogwork",
            origin: parent,
            lineage: { root: inheritedRoot, parent: null, hop: 7 },
          } as const,
          expected: {
            root: inheritedRoot,
            parent: yield* Schema.decodeEffect(LineageId)(parent),
            hop: 8,
          },
        },
      ];

      yield* Effect.forEach(
        cases,
        ({ cause, expected }) =>
          observeLineage(cause).pipe(Effect.map((lineage) => assert.deepStrictEqual(lineage, expected))),
        { discard: true },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps matching Workflow admissions invisible until the batch is durable", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const secondWrite = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const blockedStore: TriggerObservationStoreService = {
        ...store,
        putAll: (admissions) =>
          Deferred.succeed(secondWrite, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWrite)),
            Effect.andThen(store.putAll(admissions)),
          ),
      };
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, blockedStore),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* observation.refresh;
      yield* Effect.yieldNow;
      yield* scripted.emit({
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      });
      yield* Deferred.await(secondWrite);

      assert.deepStrictEqual(yield* observation.eligible, []);

      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Effect.yieldNow;
      assert.lengthOf(yield* observation.eligible, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("retries an atomic Workflow admission batch on source redelivery", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const putCount = yield* Ref.make(0);
      const failedPut = yield* Deferred.make<void>();
      const repairedPut = yield* Deferred.make<void>();
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const flakyStore: TriggerObservationStoreService = {
        ...store,
        putAll: (admissions) =>
          Ref.updateAndGet(putCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(failedPut, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(new TriggerObservationStoreError({ message: "write failed" })),
                    ),
                  )
                : store.putAll(admissions).pipe(Effect.tap(() => Deferred.succeed(repairedPut, undefined))),
            ),
          ),
      };
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, flakyStore),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      const sourceEvent = {
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      } as const;
      yield* observation.refresh;
      yield* Effect.yieldNow;
      yield* scripted.emit(sourceEvent);
      yield* Deferred.await(failedPut);
      assert.deepStrictEqual(yield* store.admissions, []);

      yield* observation.refresh;
      yield* Effect.yieldNow;
      const repaired = yield* Deferred.await(repairedPut).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(sourceEvent);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(repaired)));
      assert.lengthOf(yield* observation.eligible, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("admits once and stops the source after switch-off", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* Fiber.join(changed);

      assert.lengthOf(yield* observation.eligible, 1);
      assert.strictEqual(yield* Ref.get(observed), 1);
      assert.lengthOf(yield* scripted.subscriptions, 1);

      const redelivery = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* TestClock.adjust("1 second");
      assert.isTrue(Option.isNone(yield* Fiber.join(redelivery)));

      yield* Ref.set(current, record(false));
      const declined = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      const nextInstant = scheduledInstant + 86_400_000;
      yield* scripted.emit({
        ...event,
        key: { ...event.key, instantMillis: nextInstant },
        revision: String(nextInstant),
        atMillis: nextInstant,
      });
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(declined)));
      assert.strictEqual(yield* Ref.get(observed), 2);

      yield* bus.publish({ _tag: "WorkflowChanged", workflow: record(false) });
      yield* Effect.yieldNow;

      assert.deepStrictEqual(yield* observation.eligible, []);
      assert.deepStrictEqual(yield* scripted.subscriptions, []);
    }).pipe(Effect.scoped),
  );

  it.effect("admits a standalone pull request through an assignee-gated Workspace", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls } = yield* makeWorkspaceObservation();
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        ...selectedEvent,
        key: { _tag: "PullRequest", workspace: selectedWorkspaceId, number: 7 },
        revision: "pull-7",
      });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(changed);

      assert.isTrue(Option.isSome(result));
      assert.strictEqual(yield* Ref.get(trackerCalls), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses one assignee snapshot for a Trigger batch", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls } = yield* makeWorkspaceObservation();
      const changed = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({ ...selectedEvent, revision: "issue-2" });
      yield* Fiber.join(changed);

      assert.strictEqual(yield* Ref.get(trackerCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("loads and reuses assignees for an item outside the tracker snapshot", () =>
    Effect.gen(function* () {
      const { observation, scripted, trackerCalls, exactAssigneeCalls } = yield* makeWorkspaceObservation({
        observedItems: [],
        exactAssignees: () => Effect.succeed(["owner"]),
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({ ...selectedEvent, revision: "issue-2" });
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(changed)));
      assert.strictEqual(yield* Ref.get(trackerCalls), 1);
      assert.strictEqual(yield* Ref.get(exactAssigneeCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps observing after one assignee lookup fails", () =>
    Effect.gen(function* () {
      const { observation, scripted, exactAssigneeCalls } = yield* makeWorkspaceObservation({
        observedItems: [],
        exactAssignees: (itemId) =>
          itemId === selectedIssueId
            ? Effect.fail(
                new IssueTrackerError({
                  reason: "unavailable",
                  retryable: false,
                  message: "unrecognized work item id",
                }),
              )
            : Effect.succeed(["owner"]),
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* scripted.emit(selectedEvent);
      yield* scripted.emit({
        ...selectedEvent,
        key: { ...selectedEvent.key, id: nextSelectedIssueId },
        revision: "issue-2",
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      const result = yield* Fiber.join(changed);
      assert.strictEqual(yield* Ref.get(exactAssigneeCalls), 2);
      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.key._tag, "Issue");
      assert.strictEqual(Option.getOrThrow(result)[0]?.event.revision, "issue-2");
    }).pipe(Effect.scoped),
  );

  it.effect("offers one conversation revision at a time", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>("200.000");
      const store = yield* makeMemoryTriggerObservationStore;
      const conversation = {
        _tag: "SlackConversation",
        team: "T123",
        channel: "C123",
        threadTs: "100.000",
      } as const;
      const admission = (revision: string, atMillis: number) => ({
        event: { ...event, key: conversation, revision, atMillis },
        subscription,
        lineage: { ...lineage, root: Schema.decodeSync(LineageId)(keyOf(conversation)) },
      });
      yield* store.putAll([admission("200.000", 200_000), admission("100.000", 100_000)]);
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        ["100.000"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("offers a later conversation revision posted before an exhausted operation park", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>("100.000");
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>("200.000");
      const store = yield* makeMemoryTriggerObservationStore;
      const conversation = {
        _tag: "SlackConversation",
        team: "T123",
        channel: "C123",
        threadTs: "100.000",
      } as const;
      const operation = { workflow: subscription.workflow, operation: subscription.operation };
      const conversationLineage = {
        ...lineage,
        root: yield* Schema.decodeEffect(LineageId)(keyOf(conversation)),
      };
      const laterAdmission = {
        event: { ...event, key: conversation, revision: "200.000", atMillis: 200_000 },
        subscription,
        lineage: conversationLineage,
      };
      yield* store.putAll([laterAdmission]);
      const parkedCoordination = {
        ...coordinationService(processed, observed, sourceRevision),
        read: () =>
          Effect.succeed(
            fold(
              {
                claim: null,
                attempts: [100_000, 110_000, 120_000].map((atMillis) =>
                  AttemptRecord.make({
                    operation,
                    outcome: "failed",
                    atMillis,
                    lineage: conversationLineage,
                  }),
                ),
                handbacks: [],
                parks: [
                  ParkRecord.make({
                    reason: { _tag: "Exhausted", reason: "failure limit" },
                    operation,
                    atMillis: 300_000,
                  }),
                ],
                revision: { observed: "200.000", processed: "100.000" },
              },
              "cogwork",
            ),
          ),
      } satisfies CoordinationService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, parkedCoordination),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        ["200.000"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("removes disabled siblings before offering an admission", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(event.revision);
      const store = yield* makeMemoryTriggerObservationStore;
      const enabledAdmission = { event, subscription, lineage };
      const disabledAdmission = {
        ...enabledAdmission,
        subscription: { ...subscription, workflow: otherWorkflowId },
      };
      yield* store.putAll([enabledAdmission, disabledAdmission]);
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(false), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ subscription: candidate }) => candidate.workflow),
        [workflowId],
      );
      yield* store.complete(enabledAdmission, Ref.set(processed, event.revision));
      assert.deepStrictEqual(yield* store.admissions, []);
      assert.strictEqual(yield* Ref.get(processed), event.revision);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a rate-limited source only after Retry-After", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const starts = yield* Ref.make(0);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const rateLimited = sourceFailingOnce(
        starts,
        new SourceFailure({
          source: "clock",
          reason: "rate-limited",
          retryAfterMillis: 12_000,
          message: "wait",
        }),
      );
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [rateLimited]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* Effect.yieldNow;

      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust(11_999);
      yield* observation.refresh;
      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust(1);
      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a connection-blocked source when Connections change", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const starts = yield* Ref.make(0);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const blocked = sourceFailingOnce(
        starts,
        new SourceFailure({
          source: "clock",
          reason: "connection-not-ready",
          retryAfterMillis: null,
          message: "connect",
        }),
      );
      yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [blocked]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Ref.get(starts), 1);

      yield* bus.publish({
        _tag: "ConnectionsChanged",
        connections: { connections: [] },
        danglingWorkspaces: [],
      });
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("observes and parks one rejection before admitting every matching Trigger", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<WorkflowRecord>({
        ...record(true),
        workingCopy: granolaDocument,
        publishedCopy: granolaDocument,
      });
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const parks = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const baseCoordination = coordinationService(processed, observed, sourceRevision);
      const coordination: CoordinationService = {
        ...baseCoordination,
        park: (ref, reason) =>
          baseCoordination.read(ref).pipe(
            Effect.tap((view) => Effect.sync(() => assert.isNotNull(view.revision))),
            Effect.andThen(Ref.update(parks, (current) => [...current, reason])),
            Effect.andThen(baseCoordination.read(ref)),
          ),
      };
      const scripted = yield* makeScriptedSource("granola", granolaEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const tracker = yield* makeEmptyIssueTracker;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, tracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const changes = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        key: {
          _tag: "GranolaNote",
          connection: connectionIdOf("granola", "person@example.com"),
          noteId: "note-1",
        },
        revision: "2026-10-29T15:00:00.000Z",
        cause: { _tag: "Unknown" },
        atMillis: 1,
        entry: granolaEntry,
        workspace: null,
        payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
      });

      assert.lengthOf(yield* Fiber.join(changes), 2);
      assert.lengthOf(yield* observation.eligible, 2);
      assert.strictEqual(yield* Ref.get(observed), 1);
      assert.deepStrictEqual(yield* Ref.get(parks), [
        {
          _tag: "PlanRejected",
          reason: "Granola note has no transcript",
          entry: granolaEntry,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("records an unmatched revision without reopening prior admissions", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<WorkflowRecord>({
        ...record(true),
        workingCopy: granolaDocument,
        publishedCopy: granolaDocument,
      });
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const unmatchedRevision = "2026-10-29T16:00:00.000Z";
      const unmatchedObserved = yield* Deferred.make<void>();
      const baseCoordination = coordinationService(processed, observed, sourceRevision);
      const coordination: CoordinationService = {
        ...baseCoordination,
        observe: (ref, revision, cause) =>
          baseCoordination
            .observe(ref, revision, cause)
            .pipe(
              Effect.tap(() =>
                revision === unmatchedRevision ? Deferred.succeed(unmatchedObserved, undefined) : Effect.void,
              ),
            ),
      };
      const scripted = yield* makeScriptedSource("granola", granolaEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const firstRevision = "2026-10-29T15:00:00.000Z";
      const key = {
        _tag: "GranolaNote",
        connection: connectionIdOf("granola", "person@example.com"),
        noteId: "note-1",
      } satisfies WorkItemRef;
      const firstChanges = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        key,
        revision: firstRevision,
        cause: { _tag: "Unknown" },
        atMillis: 1,
        entry: granolaEntry,
        workspace: null,
      });
      yield* Fiber.join(firstChanges);
      yield* coordination.markProcessed(key, firstRevision);

      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        key,
        revision: unmatchedRevision,
        cause: { _tag: "Unknown" },
        atMillis: 2,
        entry: granolaEditedEntry,
        workspace: null,
      });
      yield* Deferred.await(unmatchedObserved);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(changed)));
      assert.deepStrictEqual(yield* observation.eligible, []);
      assert.strictEqual(yield* Ref.get(observed), 2);
    }).pipe(Effect.scoped),
  );
  it.effect("keeps the activated catch-up window while admitting events", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const current = yield* Ref.make<WorkflowRecord>({
        ...record(true),
        workingCopy: granolaDocument,
        publishedCopy: granolaDocument,
      });
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("granola", granolaEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const tracker = yield* makeEmptyIssueTracker;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, tracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const changes = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        key: {
          _tag: "GranolaNote",
          connection: connectionIdOf("granola", "person@example.com"),
          noteId: "note-before-switch-on",
        },
        revision: "2026-10-29T15:00:00.000Z",
        cause: { _tag: "Unknown" },
        atMillis: 999,
        entry: granolaEntry,
        workspace: null,
      });
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(changes)));
      assert.deepStrictEqual(yield* observation.eligible, []);
    }).pipe(Effect.scoped),
  );
});

layer(NodeServices.layer)((it) => {
  it.effect("persists and completes every matching Workflow admission for one revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const sourceEvent = {
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      } as const;
      const sourceLineageRoot = yield* Schema.decodeEffect(LineageId)(keyOf(sourceEvent.key));
      const sourceLineage = {
        root: sourceLineageRoot,
        parent: null,
        hop: 0,
      } as const;
      const first = { event: sourceEvent, subscription, lineage: sourceLineage };
      const second = {
        event: sourceEvent,
        subscription: { ...subscription, workflow: otherWorkflowId },
        lineage: sourceLineage,
      };
      const closed = yield* Ref.make(0);
      const closeRevision = Ref.update(closed, (count) => count + 1);
      const result = yield* makeControlStoreTriggerObservationStore.pipe(
        Effect.flatMap((store) =>
          Effect.all([
            store.putAll([first, second]),
            store.admissions,
            store.complete(first, closeRevision),
            Ref.get(closed),
            store.admissions,
            store.complete(second, closeRevision),
            Ref.get(closed),
            store.admissions,
          ]).pipe(
            Effect.map(([, stored, , closedAfterFirst, afterFirst, , closedAfterSecond, remaining]) => ({
              stored,
              closedAfterFirst,
              afterFirst,
              closedAfterSecond,
              remaining,
            })),
          ),
        ),
        Effect.provide(bootControlStoreLayer(storePath)),
      );

      assert.deepStrictEqual(
        result.stored.map(({ subscription }) => subscription.workflow).toSorted(),
        [workflowId, otherWorkflowId].toSorted(),
      );
      assert.deepStrictEqual(
        result.afterFirst.map(({ subscription }) => subscription.workflow),
        [otherWorkflowId],
      );
      assert.strictEqual(result.closedAfterFirst, 0);
      assert.strictEqual(result.closedAfterSecond, 1);
      assert.deepStrictEqual(result.remaining, []);
    }),
  );

  it.effect("rolls back revision close when finishing the last admission fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const admission = { event, subscription, lineage } as const;
      const result = yield* exerciseFailedLastAdmissionFinish(storePath, admission);

      assert.strictEqual(result.failure._tag, "TriggerObservationStoreError");
      assert.deepStrictEqual(result.failedView.revision, { observed: event.revision, processed: null });
      assert.deepStrictEqual(result.pending, [admission]);
      assert.deepStrictEqual(result.completedView.revision, {
        observed: event.revision,
        processed: event.revision,
      });
      assert.deepStrictEqual(result.remaining, []);
    }),
  );

  it.effect("rolls back fan-out children when finishing the parent fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const parent = { event, subscription, lineage } as const;
      const child = {
        ...parent,
        event: {
          ...event,
          key: { ...event.key, instantMillis: event.key.instantMillis + 1 },
          revision: String(event.key.instantMillis + 1),
        },
      };
      const result = yield* exerciseFailedFanOutFinish(parent, child).pipe(
        Effect.provide(bootControlStoreLayer(storePath)),
      );

      assert.strictEqual(result.failure._tag, "TriggerObservationStoreError");
      assert.deepStrictEqual(result.pending, [parent]);
    }),
  );

  it.effect("persists admissions and skips time spent switched off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-observation-" });
      const storePath = path.join(directory, "control.db");
      const admission = {
        event,
        subscription,
        lineage,
      } as const;
      const useStore = <A, E, R>(
        use: (
          store: Effect.Success<typeof makeControlStoreTriggerObservationStore>,
        ) => Effect.Effect<A, E, R>,
      ) =>
        Effect.flatMap(makeControlStoreTriggerObservationStore, use).pipe(
          Effect.provide(bootControlStoreLayer(storePath)),
        );

      yield* useStore((store) =>
        store
          .activate([subscription], 1_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 2_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store.activate([subscription], 3_000).pipe(
          Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          Effect.andThen(
            store.putAll([
              {
                ...admission,
                event: {
                  ...admission.event,
                  key: { ...admission.event.key, instantMillis: 1_500 },
                  revision: "1500",
                  atMillis: 1_500,
                },
              },
            ]),
          ),
        ),
      );
      yield* useStore((store) =>
        Effect.all([store.admissions, store.activate([subscription], 4_000)]).pipe(
          Effect.tap(([admissions, active]) =>
            Effect.sync(() => {
              assert.strictEqual(admissions[0]?.event.revision, "1500");
              assert.strictEqual(active[0]?.catchUp?.since, 1_500);
            }),
          ),
          Effect.andThen(store.activate([], 5_000)),
        ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 6_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 6_000))),
          ),
      );
    }),
  );
});
