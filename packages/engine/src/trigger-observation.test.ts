import { connectionIdOf, keyOf, LineageId, type WorkflowRecord, type WorkItemRef } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { clockEntries } from "./clock-source";
import { Coordination, type CoordinationService } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { granolaEntries } from "./granola-source";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { makeScriptedSource } from "./scripted-source";
import { make } from "./trigger-observation";
import {
  coordinationService,
  event,
  granolaDocument,
  granolaEditedEntry,
  granolaEntry,
  observeLineage,
  otherWorkflowId,
  record,
  selectedEvent,
  workflowId,
  workflowService,
  workItem,
} from "./trigger-observation-fixtures";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservationStore,
  TriggerObservationStoreError,
  type TriggerObservationStoreService,
} from "./trigger-observation-store";
import { TriggerSources } from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

describe("TriggerObservation", () => {
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
        Effect.timeoutOption("2 minutes"),
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
          cause: { _tag: "Clock" } as const,
          expected: {
            root: yield* Schema.decodeEffect(LineageId)(
              `${keyOf(selectedEvent.key)}:${selectedEvent.revision}`,
            ),
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
});
