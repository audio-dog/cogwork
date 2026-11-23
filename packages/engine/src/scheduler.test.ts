import { keyOf, WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { emptyRegistry, type RegistryState } from "./projector";
import { schedulerStatsOf } from "./read-model";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { Scheduler, layer as schedulerLayer } from "./scheduler";
import { TriggerObservation } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { lineage, selectedEvent, subscription } from "./trigger-observation-fixtures";
import { WorkflowRun, type WorkflowRunOutcome } from "./workflow-run";
import { admission } from "./workflow-run-admissions-fixtures";
import { workflow } from "./workflow-run-documents-fixtures";

const admissionOf = (id: string): TriggerAdmission => ({
  event: {
    ...selectedEvent,
    key: { ...selectedEvent.key, id: Schema.decodeSync(WorkItemId)(id) },
    revision: `issue-${id}`,
  },
  subscription,
  lineage,
});
const itemOf = (admission: TriggerAdmission) => keyOf(admission.event.key);

interface ProbeState {
  readonly waiting: ReadonlySet<string>;
  readonly declined: ReadonlySet<string>;
  readonly checks: ReadonlyArray<string>;
  readonly executions: ReadonlyArray<string>;
}

class Probe extends Context.Service<
  Probe,
  {
    readonly state: Ref.Ref<ProbeState>;
    readonly checkStarted: Deferred.Deferred<void>;
    readonly checkGate: Latch.Latch;
  }
>()("@cogwork/engine/scheduler.test/Probe") {
  static readonly layer = Layer.effect(
    Probe,
    Effect.all({
      state: Ref.make<ProbeState>({ waiting: new Set(), declined: new Set(), checks: [], executions: [] }),
      checkStarted: Deferred.make<void>(),
      checkGate: Latch.make(true),
    }),
  );
}

const workflowRunStub = Layer.effect(
  WorkflowRun,
  Effect.gen(function* () {
    const { state, checkStarted, checkGate } = yield* Probe;
    return {
      ...WorkflowRun.defaultValue(),
      isWaiting: (admission: TriggerAdmission) =>
        Ref.modify(state, (current) => [
          current.waiting.has(itemOf(admission)),
          { ...current, checks: [...current.checks, itemOf(admission)] },
        ]).pipe(
          Effect.tap(() => Deferred.succeed(checkStarted, undefined).pipe(Effect.andThen(checkGate.await))),
        ),
      execute: (admission: TriggerAdmission) =>
        Ref.modify(state, (current) => [
          current.declined.has(itemOf(admission)) ? ("waiting" as const) : ("completed" as const),
          { ...current, executions: [...current.executions, itemOf(admission)] },
        ]),
    };
  }),
);

const testLayer = (admissions: ReadonlyArray<TriggerAdmission>) =>
  schedulerLayer({ globalLimit: 10, perWorkspaceLimit: 4, dailyBudget: 100 }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        workflowRunStub,
        Layer.succeed(TriggerObservation, {
          ...TriggerObservation.defaultValue(),
          eligible: Effect.succeed(admissions),
        }),
        Layer.succeed(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
        Layer.mock(RunLedger, {}),
      ).pipe(Layer.provideMerge(Probe.layer)),
    ),
  );

const setReadiness = Effect.fn("SchedulerTest.setReadiness")(function* (
  change: Partial<Pick<ProbeState, "waiting" | "declined">>,
) {
  yield* Ref.update((yield* Probe).state, (current) => ({ ...current, ...change }));
});

const recorded = Effect.fn("SchedulerTest.recorded")(function* () {
  return yield* Ref.get((yield* Probe).state);
});

const recheckInterval = Duration.minutes(1);
const blocked = ["#1", "#2", "#3", "#4"].map(admissionOf);
const ready = admissionOf("#5");

describe("Scheduler", () => {
  it.effect("starts a ready candidate behind more waiting candidates than free Workspace slots", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      yield* setReadiness({ waiting: new Set(blocked.map(itemOf)) });

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;

      assert.deepStrictEqual((yield* recorded()).executions, [itemOf(ready)]);
    }).pipe(Effect.provide(testLayer([...blocked, ready]))),
  );

  it.effect("checks a waiting candidate again only after the recheck interval", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      yield* setReadiness({ waiting: new Set([itemOf(ready)]) });

      assert.strictEqual(yield* scheduler.tick(), 0);
      yield* TestClock.adjust(Duration.toMillis(recheckInterval) - 1);
      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.deepStrictEqual((yield* recorded()).checks, [itemOf(ready)]);

      yield* setReadiness({ waiting: new Set() });
      yield* TestClock.adjust(1);
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;

      const { checks, executions } = yield* recorded();
      assert.deepStrictEqual(checks, [itemOf(ready), itemOf(ready)]);
      assert.deepStrictEqual(executions, [itemOf(ready)]);
    }).pipe(Effect.provide(testLayer([ready]))),
  );

  it.effect("starts the recheck interval when the readiness check ends", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const { checkStarted, checkGate } = yield* Probe;
      yield* setReadiness({ waiting: new Set([itemOf(ready)]) });
      yield* checkGate.close;

      const tick = yield* Effect.forkChild(scheduler.tick());
      yield* Deferred.await(checkStarted);
      yield* TestClock.adjust("30 seconds");
      yield* checkGate.open;
      yield* Fiber.join(tick);
      yield* TestClock.adjust(Duration.toMillis(recheckInterval) - 1);
      yield* scheduler.tick();

      assert.deepStrictEqual((yield* recorded()).checks, [itemOf(ready)]);
    }).pipe(Effect.provide(testLayer([ready]))),
  );

  it.effect("does not count a candidate as running while its readiness check runs", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const { checkStarted, checkGate } = yield* Probe;
      yield* setReadiness({ waiting: new Set([itemOf(ready)]) });
      yield* checkGate.close;

      const tick = yield* Effect.forkChild(scheduler.tick());
      yield* Deferred.await(checkStarted);
      const during = yield* scheduler.stats;
      yield* checkGate.open;

      assert.strictEqual(yield* Fiber.join(tick), 0);
      assert.deepInclude(during, { global: 0, budgetUsed: 0 });
      assert.deepInclude(yield* scheduler.stats, { global: 0, budgetUsed: 0 });
    }).pipe(Effect.provide(testLayer([ready]))),
  );

  it.effect("defers a candidate whose Run returns waiting after its reservation", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      yield* setReadiness({ declined: new Set([itemOf(ready)]) });

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.deepInclude(yield* scheduler.stats, { global: 0, budgetUsed: 0 });

      yield* setReadiness({ declined: new Set() });
      yield* TestClock.adjust(recheckInterval);
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;

      assert.deepStrictEqual((yield* recorded()).executions, [itemOf(ready), itemOf(ready)]);
    }).pipe(Effect.provide(testLayer([ready]))),
  );
});

const runsInFlight = Metric.gauge("cogwork_scheduler_runs_in_flight", {
  description: "Runs currently executing across all workflows.",
});

const workspaceId = Schema.decodeSync(WorkspaceId)("web");
const registry: RegistryState = {
  workspaces: [
    {
      source: "test",
      contributions: [],
      config: Schema.decodeSync(WorkspaceConfig)({
        id: workspaceId,
        displayName: "Test workspace",
        checkoutPath: "/repos/web",
        issueTracker: { type: "github" },
      }),
    },
  ],
  failures: [],
};
const config = { globalLimit: 4, perWorkspaceLimit: 10, dailyBudget: 50 };

const admissionAt = (instantMillis: number): TriggerAdmission => ({
  ...admission,
  event: {
    ...admission.event,
    key: { _tag: "ScheduleInstant", workflow, instantMillis },
    revision: String(instantMillis),
    workspace: workspaceId,
  },
});

class JobGates extends Context.Service<
  JobGates,
  { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
>()("@cogwork/engine/scheduler.test/JobGates") {
  static readonly layer = Layer.effect(
    JobGates,
    Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }),
  );
}

type Job = (gates: JobGates["Service"], runStarted: Effect.Effect<void>) => Effect.Effect<WorkflowRunOutcome>;

const recheckWaits: Job = (gates) => Deferred.await(gates.release).pipe(Effect.map(() => "waiting" as const));

const runStarts: Job = (gates, runStarted) =>
  runStarted.pipe(
    Effect.andThen(Deferred.succeed(gates.started, undefined)),
    Effect.andThen(Deferred.await(gates.release)),
    Effect.map(() => "completed" as const),
  );

const inFlightLayer = (admissions: ReadonlyArray<TriggerAdmission>, job: Job) =>
  schedulerLayer(config).pipe(
    Layer.provide([
      Layer.succeed(WorkspaceRegistry, readOnlyRegistry(registry)),
      Layer.mock(RunLedger, {}),
      Layer.mock(TriggerObservation, { eligible: Effect.succeed(admissions), catalog: [] }),
      Layer.unwrap(
        Effect.gen(function* () {
          const gates = yield* JobGates;
          return Layer.mock(WorkflowRun, {
            execute: (_admission, runStarted = Effect.void) => job(gates, runStarted),
            isWaiting: () => Effect.succeed(false),
            refreshReviewPlans: () => Effect.void,
          });
        }),
      ),
    ]),
    Layer.provideMerge(JobGates.layer),
  );

const reportedLoad = Effect.fn("SchedulerTest.reportedLoad")(function* () {
  const stats = schedulerStatsOf(registry, config, yield* (yield* Scheduler).stats);
  return {
    inFlight: stats.globalInFlight,
    workspaceInFlight: stats.perWorkspace[0]?.inFlight,
    dailyBudgetUsed: stats.dailyBudgetUsed,
    runsInFlightMetric: (yield* Metric.value(runsInFlight)).value,
  };
});

describe("Scheduler in-flight count", () => {
  it.effect("does not count a reservation whose recheck returns waiting", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const gates = yield* JobGates;
      const idle = { inFlight: 0, workspaceInFlight: 0, dailyBudgetUsed: 0, runsInFlightMetric: 0 };

      assert.strictEqual(yield* scheduler.tick(), 4);
      assert.deepStrictEqual(yield* reportedLoad(), idle);
      assert.strictEqual(yield* scheduler.tick(), 0);

      yield* Deferred.succeed(gates.release, undefined);
      yield* scheduler.awaitIdle;
      assert.deepStrictEqual(yield* reportedLoad(), idle);
    }).pipe(Effect.provide(inFlightLayer([1, 2, 3, 4, 5].map(admissionAt), recheckWaits))),
  );

  it.effect("counts a Run from its start until it ends", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const gates = yield* JobGates;

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* Deferred.await(gates.started);
      assert.deepStrictEqual(yield* reportedLoad(), {
        inFlight: 1,
        workspaceInFlight: 1,
        dailyBudgetUsed: 1,
        runsInFlightMetric: 1,
      });

      yield* Deferred.succeed(gates.release, undefined);
      yield* scheduler.awaitIdle;
      assert.deepStrictEqual(yield* reportedLoad(), {
        inFlight: 0,
        workspaceInFlight: 0,
        dailyBudgetUsed: 1,
        runsInFlightMetric: 0,
      });
    }).pipe(Effect.provide(inFlightLayer([admissionAt(1)], runStarts))),
  );
});
