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
  type WorkItemRef,
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
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { granolaEntries } from "./granola-source";
import { makeScriptedSource } from "./scripted-source";
import {
  make,
  makeControlStoreTriggerObservationStore,
  makeMemoryTriggerObservationStore,
  matchTriggerEvent,
  type TriggerAdmission,
  TriggerObservationStore,
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

const record = (enabled: boolean): WorkflowRecord => ({
  id: workflowId,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
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
  currentRevision: Ref.Ref<string | null>,
): CoordinationService => ({
  fold,
  read: () =>
    Effect.all([Ref.get(processed), Ref.get(currentRevision)]).pipe(
      Effect.map(([processedRevision, observedRevision]) =>
        fold(
          {
            claim: null,
            attempts: [],
            handbacks: [],
            parks: [],
            revision:
              observedRevision === null ? null : { observed: observedRevision, processed: processedRevision },
          },
          "cogwork",
        ),
      ),
    ),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: (_ref, revision) =>
    Ref.modify(currentRevision, (current) => {
      const outcome = current === revision ? "redelivered" : "moved";
      const next = outcome === "redelivered" ? current : revision;
      return [outcome, next] satisfies readonly ["moved" | "redelivered", string | null];
    }).pipe(Effect.tap(() => Ref.update(observed, (count) => count + 1))),
  markProcessed: (_ref, revision) => Ref.set(processed, revision),
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

  it.effect("admits once and stops the source after switch-off", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const currentRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, currentRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
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

      const redelivered = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(redelivered)));
      assert.strictEqual(yield* Ref.get(observed), 2);

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

  it.effect("observes and parks one rejection before admitting every matching Trigger", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<WorkflowRecord>({
        ...record(true),
        workingCopy: granolaDocument,
        publishedCopy: granolaDocument,
      });
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const currentRevision = yield* Ref.make<string | null>(null);
      const parks = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const baseCoordination = coordinationService(processed, observed, currentRevision);
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
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
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
      const currentRevision = yield* Ref.make<string | null>(null);
      const unmatchedRevision = "2026-10-29T16:00:00.000Z";
      const unmatchedObserved = yield* Deferred.make<void>();
      const baseCoordination = coordinationService(processed, observed, currentRevision);
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
      const currentRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("granola", granolaEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, currentRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
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
      yield* useStore((store) =>
        store.put(storedAdmission).pipe(
          Effect.andThen(SqlClient.SqlClient),
          Effect.flatMap(
            (sql) => sql`
              UPDATE trigger_admissions
              SET revision = ${storedAdmission.event.revision}
              WHERE work_item = ${keyOf(storedAdmission.event.key)}
            `,
          ),
        ),
      );
      yield* useStore((store) =>
        store.complete(storedAdmission).pipe(
          Effect.tap((isLast) => Effect.sync(() => assert.isTrue(isLast))),
          Effect.andThen(store.admissions),
          Effect.tap((admissions) => Effect.sync(() => assert.deepStrictEqual(admissions, []))),
        ),
      );
    }),
  );
});
