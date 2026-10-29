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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { clockEntries } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
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
  TriggerObservationStore,
  TriggerObservationStoreError,
  type TriggerObservationStoreService,
} from "./trigger-observation";
import { TriggerSources, type TriggerSubscription } from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

const workflowId = Schema.decodeSync(WorkflowId)("daily-summary");
const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
const siblingTriggerId = Schema.decodeSync(WorkflowNodeId)("schedule-sibling");
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
const siblingSubscription: TriggerSubscription = { ...subscription, trigger: siblingTriggerId };

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
  const observed = yield* Ref.make<ReadonlySet<string>>(new Set());
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
  const observation = yield* make.pipe(
    Effect.provideService(Workflows, workflowService(current)),
    Effect.provideService(Coordination, coordinationService(processed, observed)),
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
  return { observation, scripted, trackerCalls, exactAssigneeCalls, observed };
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
  observed: Ref.Ref<ReadonlySet<string>>,
): CoordinationService => ({
  fold,
  read: () =>
    Effect.map(Ref.get(processed), (revision) =>
      fold(
        {
          claim: null,
          attempts: [],
          handbacks: [],
          parks: [],
          revision: { observed: event.revision, processed: revision },
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
    Ref.modify(observed, (current) =>
      current.has(revision) ? ["redelivered", current] : ["moved", new Set([...current, revision])],
    ),
  markProcessed: (_ref, revision) => Ref.set(processed, revision),
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

  it.effect("admits once and stops the source after switch-off", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make<ReadonlySet<string>>(new Set());
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const tracker = yield* makeEmptyIssueTracker;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
        Effect.provideService(IssueTracker, tracker),
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
      assert.strictEqual((yield* Ref.get(observed)).size, 1);
      assert.lengthOf(yield* scripted.subscriptions, 1);

      const redelivered = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(redelivered)));

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
      assert.strictEqual((yield* Ref.get(observed)).size, 1);

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

  it.effect("does not record delivery before admission persistence succeeds", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryTriggerObservationStore;
      const firstPut = yield* Ref.make(true);
      const store: TriggerObservationStoreService = {
        ...memory,
        put: (admission) =>
          Ref.getAndSet(firstPut, false).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(new TriggerObservationStoreError({ message: "write failed" }))
                : memory.put(admission),
            ),
          ),
      };
      const { observation, scripted, observed } = yield* makeWorkspaceObservation({ store });
      yield* scripted.emit(selectedEvent);
      yield* Effect.yieldNow;

      assert.strictEqual((yield* Ref.get(observed)).size, 0);

      yield* TestClock.adjust("5 seconds");
      yield* observation.refresh;
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(changed)));
      assert.strictEqual((yield* Ref.get(observed)).size, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps sibling admissions for one item revision in memory", () =>
    Effect.gen(function* () {
      const store = yield* makeMemoryTriggerObservationStore;
      const admission = { event, subscription, lineage } as const;
      yield* store.put(admission);
      yield* store.put({ ...admission, subscription: siblingSubscription });

      assert.deepStrictEqual(
        (yield* store.admissions).map(({ subscription: current }) => current.trigger).toSorted(),
        [triggerId, siblingTriggerId].toSorted(),
      );
    }),
  );
});

layer(NodeServices.layer)((it) => {
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
            store.put({
              ...admission,
              event: {
                ...admission.event,
                key: { ...admission.event.key, instantMillis: 1_500 },
                revision: "1500",
                atMillis: 1_500,
              },
            }),
          ),
          Effect.andThen(
            store.put({
              ...admission,
              subscription: siblingSubscription,
              event: {
                ...admission.event,
                key: { ...admission.event.key, instantMillis: 1_500 },
                revision: "1500",
                atMillis: 1_500,
              },
            }),
          ),
        ),
      );
      yield* useStore((store) =>
        Effect.all([store.admissions, store.activate([subscription], 4_000)]).pipe(
          Effect.tap(([admissions, active]) =>
            Effect.sync(() => {
              assert.deepStrictEqual(
                admissions.map(({ subscription: current }) => current.trigger).toSorted(),
                [triggerId, siblingTriggerId].toSorted(),
              );
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
