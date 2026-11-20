import { WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";

import type { RegistryState } from "./projector";
import { schedulerStatsOf } from "./read-model";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { Scheduler, layer as schedulerLayerOf } from "./scheduler";
import { TriggerObservation } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { WorkflowRun, type WorkflowRunOutcome } from "./workflow-run";
import { admission } from "./workflow-run-admissions-fixtures";
import { workflow } from "./workflow-run-documents-fixtures";

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

const schedulerLayer = (admissions: ReadonlyArray<TriggerAdmission>, job: Job) =>
  schedulerLayerOf(config).pipe(
    Layer.provide([
      Layer.succeed(WorkspaceRegistry, readOnlyRegistry(registry)),
      Layer.mock(RunLedger, {}),
      Layer.mock(TriggerObservation, { eligible: Effect.succeed(admissions), catalog: [] }),
      Layer.unwrap(
        Effect.gen(function* () {
          const gates = yield* JobGates;
          return Layer.mock(WorkflowRun, {
            execute: (_admission, runStarted = Effect.void) => job(gates, runStarted),
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
    }).pipe(Effect.provide(schedulerLayer([1, 2, 3, 4, 5].map(admissionAt), recheckWaits))),
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
    }).pipe(Effect.provide(schedulerLayer([admissionAt(1)], runStarts))),
  );
});
