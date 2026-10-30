import {
  connectionIdOf,
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
import { clockEntries } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import { Coordination, type CoordinationService, fold } from "./coordination";
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
  workflowAdmissionRefOf,
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
const siblingSelectedDocument = Schema.decodeSync(WorkflowDocument)({
  ...selectedDocument,
  triggers: [
    ...selectedDocument.triggers,
    {
      id: siblingTriggerId,
      entry,
      parameters: scheduleParameters,
      start: Schema.decodeSync(WorkflowNodeId)("summarize"),
    },
  ],
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
    readonly publishedCopy?: WorkflowDocument;
  } = {},
) {
  const current = yield* Ref.make(record(true, options.publishedCopy ?? selectedDocument));
  const processed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const observed = yield* Ref.make<ReadonlyMap<string, ObservedDelivery>>(new Map());
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
  const coordination = coordinationService(processed, observed);
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
  return { observation, scripted, trackerCalls, exactAssigneeCalls, observed, coordination };
});

const granolaEntry = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
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

type ObservedDelivery = {
  readonly ref: Parameters<CoordinationService["read"]>[0];
  readonly revision: string;
};

const coordinationService = (
  processed: Ref.Ref<ReadonlyMap<string, string>>,
  observed: Ref.Ref<ReadonlyMap<string, ObservedDelivery>>,
): CoordinationService => ({
  fold,
  read: (ref) =>
    Effect.all([Ref.get(processed), Ref.get(observed)]).pipe(
      Effect.map(([revisions, deliveries]) => {
        const refKey = JSON.stringify(ref);
        const processedRevision = revisions.get(refKey) ?? null;
        const observedRevision = [...deliveries.values()].find(
          (delivery) => JSON.stringify(delivery.ref) === refKey,
        )?.revision;
        return fold(
          {
            claim: null,
            attempts: [],
            handbacks: [],
            parks: [],
            revision:
              observedRevision === undefined
                ? null
                : { observed: observedRevision, processed: processedRevision },
          },
          "cogwork",
        );
      }),
    ),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: (ref, revision) => {
    const delivery = { ref, revision };
    const key = JSON.stringify(delivery);
    return Ref.modify(observed, (current) =>
      current.has(key) ? ["redelivered", current] : ["moved", new Map(current).set(key, delivery)],
    );
  },
  markProcessed: (ref, revision) =>
    Ref.update(processed, (current) => new Map(current).set(JSON.stringify(ref), revision)),
});

describe("TriggerObservation", () => {
  it("matches a schedule event to one Trigger with the scheduled parameters", () => {
    const other = { ...subscription, workflow: Schema.decodeSync(WorkflowId)("other") };
    const expired = {
      ...subscription,
      trigger: Schema.decodeSync(WorkflowNodeId)("expired"),
      catchUp: { since: event.atMillis + 1 },
    };
    const later = {
      ...subscription,
      trigger: Schema.decodeSync(WorkflowNodeId)("later"),
      operation: Schema.decodeSync(WorkflowNodeId)("later-operation"),
      parameters: scheduleParameters.map((parameter) =>
        parameter.id === "hour" ? { ...parameter, value: "1" } : parameter,
      ),
    };

    assert.deepStrictEqual(matchTriggerEvent([later, expired, subscription, other], event), [subscription]);
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
      const processed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const observed = yield* Ref.make<ReadonlyMap<string, ObservedDelivery>>(new Map());
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

  it.effect("retries a redelivered revision after its admission write fails", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const observed = yield* Ref.make<ReadonlyMap<string, ObservedDelivery>>(new Map());
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const baseStore = yield* makeMemoryTriggerObservationStore;
      const putAttempts = yield* Ref.make(0);
      const failedPut = yield* Deferred.make<void>();
      const store = {
        ...baseStore,
        putAll: (admissions: ReadonlyArray<TriggerAdmission>) =>
          Ref.getAndUpdate(putAttempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 0
                ? Deferred.succeed(failedPut, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(new TriggerObservationStoreError({ message: "first write failed" })),
                    ),
                  )
                : baseStore.putAll(admissions),
            ),
          ),
      };
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
      yield* scripted.emit(event);
      yield* Deferred.await(failedPut);
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* Effect.yieldNow;
      const eligible = yield* observation.eligible;
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(changed)));
      assert.lengthOf(eligible, 1);
      assert.strictEqual(yield* Ref.get(putAttempts), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("observes and parks one rejection before admitting every matching Trigger", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<WorkflowRecord>({
        ...record(true),
        workingCopy: granolaDocument,
        publishedCopy: granolaDocument,
      });
      const processed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const observed = yield* Ref.make<ReadonlyMap<string, ObservedDelivery>>(new Map());
      const parks = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const baseCoordination = coordinationService(processed, observed);
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
      assert.strictEqual((yield* Ref.get(observed)).size, 2);
      assert.deepStrictEqual(yield* Ref.get(parks), [
        {
          _tag: "PlanRejected",
          reason: "Granola note has no transcript",
          entry: granolaEntry,
        },
        {
          _tag: "PlanRejected",
          reason: "Granola note has no transcript",
          entry: granolaEntry,
        },
      ]);
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
      const processed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const observed = yield* Ref.make<ReadonlyMap<string, ObservedDelivery>>(new Map());
      const scripted = yield* makeScriptedSource("granola", granolaEntries);
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

  it.effect("keeps sibling Triggers eligible after one processes the source revision", () =>
    Effect.gen(function* () {
      const { observation, scripted, observed, coordination } = yield* makeWorkspaceObservation({
        publishedCopy: siblingSelectedDocument,
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(selectedEvent);
      const admissions = yield* Fiber.join(changed);
      const first = admissions[0];
      assert.isDefined(first);
      if (!first) return;
      yield* coordination.markProcessed(workflowAdmissionRefOf(first), selectedEvent.revision);

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ subscription: current }) => current.trigger),
        [siblingTriggerId],
      );
      assert.strictEqual((yield* Ref.get(observed)).size, 2);
    }).pipe(Effect.scoped),
  );
});

layer(NodeServices.layer)((it) => {
  it.effect("persists sibling completion and skips time spent switched off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-observation-" });
      const storePath = path.join(directory, "control.db");
      const admission = {
        event,
        subscription,
        lineage,
      } satisfies TriggerAdmission;
      const storedAdmission = {
        ...admission,
        event: {
          ...admission.event,
          key: { ...admission.event.key, instantMillis: 1_500 },
          revision: "1500",
          atMillis: 1_500,
        },
      } satisfies TriggerAdmission;
      const siblingAdmission = {
        ...storedAdmission,
        subscription: {
          ...storedAdmission.subscription,
          trigger: siblingTriggerId,
        },
      } satisfies TriggerAdmission;
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
          Effect.andThen(store.put(storedAdmission).pipe(Effect.andThen(store.put(siblingAdmission)))),
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
              assert.strictEqual(admissions[0]?.event.revision, "1500");
              assert.lengthOf(admissions, 2);
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
      yield* useStore((store) =>
        store.complete(storedAdmission).pipe(
          Effect.tap((isLast) => Effect.sync(() => assert.isFalse(isLast))),
          Effect.andThen(store.admissions),
          Effect.tap((admissions) => Effect.sync(() => assert.lengthOf(admissions, 1))),
        ),
      );
      yield* useStore((store) =>
        store.complete(siblingAdmission).pipe(
          Effect.tap((isLast) => Effect.sync(() => assert.isTrue(isLast))),
          Effect.andThen(store.admissions),
          Effect.tap((admissions) => Effect.sync(() => assert.deepStrictEqual(admissions, []))),
        ),
      );
    }),
  );
});
