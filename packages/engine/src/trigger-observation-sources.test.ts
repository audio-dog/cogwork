import { connectionIdOf, WorkflowDocument, type WorkflowRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { clockEntries } from "./clock-source";
import { Coordination } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { granolaEntries } from "./granola-source";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { makeScriptedSource } from "./scripted-source";
import { trackerTriggerEntries } from "./tracker-trigger-source";
import { make } from "./trigger-observation";
import {
  coordinationService,
  event,
  granolaDocument,
  granolaEntry,
  issueHasLabelKey,
  makeWorkspaceObservation,
  record,
  scheduledInstant,
  selectedDocument,
  selectedEvent,
  sourceFailingOnce,
  subscription,
  triggerId,
  workflowService,
} from "./trigger-observation-fixtures";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { SourceFailure, TriggerSources } from "./trigger-source";
import { Workflows } from "./workflow";

describe("TriggerObservation", () => {
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

  it.effect("admits an item that already matched a condition at switch-on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const labelParameters = [{ id: "label", value: "needs-triage" }];
      const labelDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...selectedDocument,
        triggers: [
          {
            id: triggerId,
            entry: issueHasLabelKey,
            parameters: labelParameters,
            start: subscription.operation,
          },
        ],
      });
      const { observation, scripted } = yield* makeWorkspaceObservation({
        document: labelDocument,
        source: { id: "github", entries: trackerTriggerEntries("github") },
      });
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        ...selectedEvent,
        entry: issueHasLabelKey,
        revision: "label:needs-triage:999",
        atMillis: 999,
        parameters: labelParameters,
      });
      yield* TestClock.adjust("1 second");
      const admitted = yield* Fiber.join(changed);

      assert.deepStrictEqual(
        Option.map(admitted, (admissions) => admissions.map(({ event }) => event.revision)),
        Option.some(["label:needs-triage:999"]),
      );
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
