import {
  AttemptRecord,
  type HandbackRecord,
  keyOf,
  LineageId,
  ParkRecord,
  WorkflowCatalogKey,
  WorkflowDocument,
  type WorkItemRef,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { Coordination, type CoordinationService, fold } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { trackerTriggerEntries } from "./tracker-trigger-source";
import { make } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import {
  coordinationService,
  event,
  issueHasLabelKey,
  lineage,
  makeWorkspaceObservation,
  otherWorkflowId,
  record,
  selectedDocument,
  selectedEvent,
  selectedWorkspaceId,
  subscription,
  triggerId,
  workflowId,
  workflowService,
} from "./trigger-observation-fixtures";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { type TriggerEvent, TriggerSources } from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

const notBlocked = Schema.decodeSync(WorkflowCatalogKey)("github.issue-not-blocked");
const newCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");
const labelParameters = [{ id: "label", value: "ready-for-agent" }];

const observeFilteredTrigger = Effect.fn("TriggerObservationTest.observeFilteredTrigger")(function* (
  entry: WorkflowCatalogKey,
  coordination?: CoordinationService,
) {
  yield* TestClock.setTime(1_000);
  const document = yield* Schema.decodeEffect(WorkflowDocument)({
    ...selectedDocument,
    triggers: [
      {
        id: triggerId,
        entry,
        parameters: labelParameters,
        filters: [{ entry: notBlocked }],
        start: subscription.operation,
      },
    ],
  });
  const { observation, scripted } = yield* makeWorkspaceObservation({
    document,
    source: { id: "github", entries: trackerTriggerEntries("github") },
    ...(coordination === undefined ? {} : { coordination }),
  });
  const admitted = yield* observation.changes.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
  );
  const first = {
    ...selectedEvent,
    entry,
    revision: `${entry}:1500`,
    atMillis: 1_500,
    parameters: labelParameters,
  };
  yield* scripted.emit({ ...first, passes: [notBlocked] });
  yield* Fiber.join(admitted);
  const redeliver = (revision: string, passes: ReadonlyArray<WorkflowCatalogKey>) =>
    scripted.emit({ ...first, revision, passes }).pipe(Effect.andThen(TestClock.adjust("1 second")));
  return { observation, first, redeliver };
});

describe("TriggerObservation", () => {
  it.effect("orders waiting work by prior Workflow action, priority, then oldest revision", () =>
    Effect.gen(function* () {
      const waiting = (revision: string, priority: TriggerEvent["priority"], atMillis: number) => {
        const key = { _tag: "ScheduleInstant", workflow: workflowId, instantMillis: atMillis } as const;
        return {
          event: { ...event, key, revision, priority, atMillis },
          subscription,
          lineage: { root: LineageId.make(keyOf(key)), parent: null, hop: 0 },
        } satisfies TriggerAdmission;
      };
      const actedAdmission = waiting("acted", "low", 4);
      const admissions = [
        waiting("old-low", "low", 1),
        waiting("new-urgent", "urgent", 3),
        waiting("old-urgent", "urgent", 2),
        actedAdmission,
      ];
      const revisions = new Map(
        admissions.map(({ event: candidate }) => [keyOf(candidate.key), candidate.revision]),
      );
      const coordination = {
        ...coordinationService(
          yield* Ref.make<string | null>(null),
          yield* Ref.make(0),
          yield* Ref.make<string | null>(null),
        ),
        read: (ref: WorkItemRef) => {
          const actedOn = keyOf(ref) === keyOf(actedAdmission.event.key);
          const attempts = actedOn
            ? [
                AttemptRecord.make({
                  operation: { workflow: workflowId, operation: subscription.operation },
                  outcome: "succeeded",
                  atMillis: 1,
                  lineage: actedAdmission.lineage,
                }),
              ]
            : [];
          return Effect.succeed(
            fold(
              {
                claim: null,
                attempts,
                handbacks: [],
                parks: [],
                revision: { observed: revisions.get(keyOf(ref)) ?? event.revision, processed: null },
              },
              "cogwork",
              0,
            ),
          );
        },
      } satisfies CoordinationService;
      const store = yield* makeMemoryTriggerObservationStore;
      yield* store.putAll(admissions);
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(yield* Ref.make(record(true)))),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        ["acted", "old-urgent", "new-urgent", "old-low"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("offers an admitted issue only while a redelivery still passes its Trigger's filters", () =>
    Effect.gen(function* () {
      const { observation, first, redeliver } = yield* observeFilteredTrigger(issueHasLabelKey);
      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        [first.revision],
      );

      yield* redeliver(first.revision, []);
      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        [],
      );

      yield* redeliver(first.revision, [notBlocked]);
      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        [first.revision],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("offers a filtered-out admission again when it passes after a newer revision was observed", () =>
    Effect.gen(function* () {
      const latest = yield* Ref.make<string | null>(null);
      const seen = yield* Ref.make<ReadonlySet<string>>(new Set());
      const coordination = {
        ...coordinationService(yield* Ref.make<string | null>(null), yield* Ref.make(0), latest),
        observe: (_ref: WorkItemRef, revision: string) =>
          Ref.modify(
            seen,
            (current) =>
              [current.has(revision) ? "redelivered" : "moved", new Set(current).add(revision)] as const,
          ).pipe(
            Effect.tap((outcome) =>
              Ref.update(latest, (previous) => (outcome === "moved" ? revision : previous)),
            ),
          ),
      } satisfies CoordinationService;
      const { observation, first, redeliver } = yield* observeFilteredTrigger(issueHasLabelKey, coordination);

      yield* redeliver(first.revision, []);
      yield* redeliver(`${issueHasLabelKey}:2500`, []);
      yield* redeliver(first.revision, [notBlocked]);

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        [first.revision],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a catch-up Trigger's admission offered when a redelivery fails its filters", () =>
    Effect.gen(function* () {
      const { observation, first, redeliver } = yield* observeFilteredTrigger(newCommentKey);

      yield* redeliver(first.revision, []);

      assert.deepStrictEqual(
        (yield* observation.eligible).map(({ event: candidate }) => candidate.revision),
        [first.revision],
      );
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

  it.effect("keeps a later conversation revision behind an exhausted operation park", () =>
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
              0,
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
        [],
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

  it.effect("wakes one round when a pull request event starts after a stuck attempt", () =>
    Effect.gen(function* () {
      const pullRequest = { _tag: "PullRequest", workspace: selectedWorkspaceId, number: 7 } as const;
      const operation = { workflow: subscription.workflow, operation: subscription.operation };
      const pullLineage = { ...lineage, root: yield* Schema.decodeEffect(LineageId)(keyOf(pullRequest)) };
      const admission = (revision: string, atMillis: number) => ({
        event: { ...event, key: pullRequest, revision, atMillis },
        subscription,
        lineage: pullLineage,
      });
      const handbacks = yield* Ref.make<ReadonlyArray<HandbackRecord>>([]);
      const read = () =>
        Ref.get(handbacks).pipe(
          Effect.map((recorded) =>
            fold(
              {
                claim: null,
                attempts: [
                  AttemptRecord.make({
                    operation,
                    outcome: "failed",
                    atMillis: 5_000,
                    lineage: pullLineage,
                  }),
                ],
                handbacks: recorded,
                parks: [
                  ParkRecord.make({
                    reason: { _tag: "Stuck", summary: "needs a person" },
                    operation,
                    atMillis: 5_001,
                  }),
                ],
                revision: { observed: "checks:head:test", processed: null },
              },
              "cogwork",
              0,
            ),
          ),
        );
      const coordination = {
        ...coordinationService(
          yield* Ref.make<string | null>(null),
          yield* Ref.make(0),
          yield* Ref.make<string | null>(null),
        ),
        read,
        handBack: (_ref: WorkItemRef, input: { readonly by: string }) =>
          Ref.update(handbacks, (current) => [
            ...current,
            { by: input.by, note: null, atMillis: 9_000 },
          ]).pipe(Effect.andThen(read())),
      } satisfies CoordinationService;
      const store = yield* makeMemoryTriggerObservationStore;
      yield* store.putAll([
        admission("review-comment-1", 1_000),
        admission("conflict:head:base-1", 4_000),
        admission("conflict:head:base-2", 4_000),
      ]);
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(yield* Ref.make(record(true)))),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      const offered = () =>
        observation.eligible.pipe(
          Effect.map((admissions) => admissions.map(({ event: candidate }) => candidate.revision)),
        );

      assert.deepStrictEqual(yield* offered(), []);
      assert.deepStrictEqual(yield* Ref.get(handbacks), []);

      yield* store.putAll([admission("review-comment-2", 6_000), admission("checks:head:test", 7_000)]);

      assert.deepStrictEqual(yield* offered(), ["checks:head:test"]);
      assert.deepStrictEqual(yield* offered(), ["checks:head:test"]);
      assert.deepStrictEqual(
        (yield* Ref.get(handbacks)).map(({ by }) => by),
        ["cogwork"],
      );
      assert.deepStrictEqual(
        (yield* store.admissions).map(({ event: candidate }) => candidate.revision),
        ["checks:head:test"],
      );
    }).pipe(Effect.scoped),
  );
});
