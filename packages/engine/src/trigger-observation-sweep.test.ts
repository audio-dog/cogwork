import {
  keyOf,
  LineageId,
  type RunPlanWorkContextProse,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { clockSource } from "./clock-source";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker, type TrackerItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { make } from "./trigger-observation";
import {
  coordinationService,
  lineage,
  record,
  selectedDocument,
  selectedEvent,
  selectedTrackerItem,
  selectedWorkspace,
  selectedWorkspaceId,
  subscription,
  workflowService,
} from "./trigger-observation-fixtures";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { type SourceFailure, type TriggerEvent, type TriggerSource, TriggerSources } from "./trigger-source";
import { Workflows } from "./workflow";

describe("TriggerObservation", () => {
  it.effect("sweeps 60 parked idle issues across two ticks without repeating the first 50", () =>
    Effect.gen(function* () {
      const start = Date.UTC(2026, 0, 1);
      const day = 86_400_000;
      yield* TestClock.setTime(start);
      const sweepDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        name: "Staleness sweep",
        workspaces: { _tag: "Every" },
        triggers: [
          {
            id: "sweep",
            entry: "schedule.sweep",
            parameters: [
              { id: "hour", value: "0" },
              { id: "minute", value: "1" },
              { id: "zone", value: "UTC" },
              { id: "source", value: "trackers" },
              { id: "state", value: "parked" },
              { id: "idle-days", value: "30" },
            ],
            start: "judge",
          },
        ],
        operations: [
          {
            id: "judge",
            name: "Judge",
            instructionPackage: null,
            instruction: "Judge the parked issue.",
            permissionProfile: "read-only",
            requires: [],
            model: { harness: null, model: null, options: [] },
            forEach: null,
            questions: [],
            transitions: [
              {
                when: [],
                actions: [{ entry: "github.close-this-issue", parameters: [] }],
                handOff: null,
              },
            ],
            hints: [],
          },
        ],
      });
      const parked = (index: number, lastTouchedAtMillis: number) =>
        ({
          ...selectedTrackerItem,
          id: Schema.decodeSync(WorkItemId)(`#${index}`),
          title: `Parked issue ${index}`,
          url: `https://github.com/acme/example/issues/${index}`,
          lastTouchedAtMillis,
        }) satisfies TrackerItem;
      const candidates = [
        ...Array.from({ length: 60 }, (_, index) => parked(index + 1, start - (120 - index) * day)),
        parked(61, start - day),
      ];
      const linearWorkspace: RegisteredWorkspace = {
        source: "test",
        contributions: [],
        config: yield* Schema.decodeEffect(WorkspaceConfig)({
          id: "linear",
          displayName: "linear",
          checkoutPath: "/repos/linear",
          issueTracker: { type: "linear", teams: ["LIN"] },
        }),
      };
      const current = yield* Ref.make(record(true, sweepDocument));
      const sourceRevisions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const coordination: CoordinationService = {
        fold,
        read: (ref) =>
          Ref.get(sourceRevisions).pipe(
            Effect.map((revisions) =>
              fold(
                {
                  claim: null,
                  attempts: [],
                  handbacks: [],
                  parks:
                    ref._tag === "Issue"
                      ? [{ reason: { _tag: "Stuck", summary: "parked" }, atMillis: 1 }]
                      : [],
                  revision: {
                    observed: revisions.get(keyOf(ref)) ?? "unobserved",
                    processed: null,
                  },
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
        observe: (ref, revision) =>
          Ref.modify(sourceRevisions, (revisions) => {
            const item = keyOf(ref);
            const outcome = revisions.get(item) === revision ? "redelivered" : "moved";
            return [outcome, new Map(revisions).set(item, revision)] as const;
          }),
        markProcessed: () => Effect.void,
      };
      const store = yield* makeMemoryTriggerObservationStore;
      const emptyTracker = yield* makeEmptyIssueTracker;
      const startSweep = yield* Deferred.make<void>();
      const sweepSource = {
        ...clockSource,
        observe: (subscriptions, readPort) => {
          const subscription = subscriptions[0];
          if (subscription === undefined || readPort === undefined) {
            return Stream.empty as ReturnType<TriggerSource["observe"]>;
          }
          const tick = (instant: number) =>
            Stream.fromEffect(readPort.sweep(subscription, instant)).pipe(
              Stream.flatMap((read) =>
                Stream.fromIterable(
                  read
                    .filter(({ lastTouchedAtMillis }) => lastTouchedAtMillis <= instant - 30 * day)
                    .toSorted(
                      (left, right) =>
                        left.lastTouchedAtMillis - right.lastTouchedAtMillis ||
                        keyOf(left.key).localeCompare(keyOf(right.key)),
                    )
                    .slice(0, 50),
                ),
              ),
              Stream.mapEffect((candidate) => {
                const noWorkContext: RunPlanWorkContextProse | undefined = undefined;
                const loadWorkContext: Effect.Effect<RunPlanWorkContextProse | undefined, SourceFailure> =
                  candidate.loadWorkContext ?? Effect.succeed(noWorkContext);
                return loadWorkContext.pipe(
                  Effect.map(
                    (workContext) =>
                      ({
                        key: candidate.key,
                        revision: `${subscription.workflow}:${instant}`,
                        cause: { _tag: "Clock" as const },
                        atMillis: instant,
                        entry: subscription.entry,
                        workspace: candidate.workspace,
                        target: { workflow: subscription.workflow, trigger: subscription.trigger },
                        ...(workContext === undefined ? {} : { workContext }),
                      }) satisfies TriggerEvent,
                  ),
                );
              }),
            );
          return Stream.fromEffect(Deferred.await(startSweep)).pipe(
            Stream.flatMap(() => Stream.concat(tick(start + 60_000), tick(start + day + 60_000))),
          );
        },
      } satisfies TriggerSource;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordination),
        Effect.provideService(TriggerSources, [sweepSource]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, {
          ...emptyTracker,
          observe: (workspace) =>
            Effect.succeed(
              workspace.config.issueTracker.type === "linear" ? [parked(99, start - 200 * day)] : candidates,
            ),
          readProse: (_workspace, id) => Effect.succeed({ body: `Parked body ${id}`, comments: [] }),
        }),
        Effect.provideService(
          WorkspaceRegistry,
          readOnlyRegistry({ workspaces: [selectedWorkspace, linearWorkspace], failures: [] }),
        ),
      );
      const changed = yield* observation.changes.pipe(
        Stream.take(60),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* Deferred.succeed(startSweep, undefined);
      const admitted = yield* Fiber.join(changed);

      assert.deepStrictEqual(
        admitted.map(({ event }) => (event.key._tag === "Issue" ? event.key.id : "")),
        Array.from({ length: 60 }, (_, index) => `#${index + 1}`),
      );
      assert.isTrue(admitted.every(({ event }) => event.cause._tag === "Clock"));
      assert.strictEqual(new Set(admitted.map(({ event }) => event.revision)).size, 2);
      assert.strictEqual(new Set(admitted.map(({ lineage }) => lineage.root)).size, 60);
      assert.strictEqual(admitted[0]?.event.workContext?.body, "Parked body #1");
    }).pipe(Effect.scoped),
  );

  it.effect("sweeps a parked pull request through an assignee-gated Workspace", () =>
    Effect.gen(function* () {
      const start = Date.UTC(2026, 0, 1);
      yield* TestClock.setTime(start);
      const sweepDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...selectedDocument,
        triggers: [
          {
            id: "sweep",
            entry: "schedule.sweep",
            parameters: [
              { id: "hour", value: "0" },
              { id: "minute", value: "1" },
              { id: "zone", value: "UTC" },
              { id: "source", value: "workflow" },
              { id: "state", value: "parked" },
              { id: "idle-days", value: "30" },
            ],
            start: "summarize",
          },
        ],
      });
      const pullRequestKey = { _tag: "PullRequest", workspace: selectedWorkspaceId, number: 7 } as const;
      const pullRequest = { author: "owner", headRef: "feature", closingIssueNumbers: [] };
      const store = yield* makeMemoryTriggerObservationStore;
      yield* store.putAll([
        {
          event: {
            ...selectedEvent,
            key: pullRequestKey,
            entry: yield* Schema.decodeEffect(WorkflowCatalogKey)("github.pull-request-checks-failed"),
            revision: "pull-7",
            atMillis: start - 60 * 86_400_000,
            pullRequest,
          },
          subscription,
          lineage: { ...lineage, root: yield* Schema.decodeEffect(LineageId)(keyOf(pullRequestKey)) },
        },
      ]);
      const processed = yield* Ref.make<string | null>(null);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const unparked = coordinationService(processed, yield* Ref.make(0), sourceRevision);
      const parked = {
        ...unparked,
        read: (ref) =>
          unparked.read(ref).pipe(
            Effect.map((view) => ({
              ...view,
              park: { reason: { _tag: "Stuck", summary: "parked" }, atMillis: start - 60 * 86_400_000 },
            })),
          ),
      } satisfies CoordinationService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(yield* Ref.make(record(true, sweepDocument)))),
        Effect.provideService(Coordination, parked),
        Effect.provideService(TriggerSources, [clockSource]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, {
          ...(yield* makeEmptyIssueTracker),
          observe: () => Effect.succeed([selectedTrackerItem]),
        }),
        Effect.provideService(
          WorkspaceRegistry,
          readOnlyRegistry({ workspaces: [selectedWorkspace], failures: [] }),
        ),
      );
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* TestClock.adjust("1 minute");
      const settled = yield* Fiber.join(changed).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("10 seconds");
      const [swept] = Option.getOrElse(yield* Fiber.join(settled), () => []);

      assert.deepStrictEqual(swept?.event.cause, { _tag: "Clock" });
      assert.deepStrictEqual(swept?.event.key, pullRequestKey);
      assert.deepStrictEqual(swept?.event.pullRequest, pullRequest);
    }).pipe(Effect.scoped),
  );
});
