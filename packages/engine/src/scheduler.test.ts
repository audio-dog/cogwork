import {
  DaemonEvent,
  HarnessName,
  keyOf,
  type LifecycleStage,
  LineageId,
  type Priority,
  RunId,
  type RunRecord,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
  type WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type { EligibleWork } from "./classify";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import type { RegisteredWorkspace } from "./projector";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import { engineTestLayer } from "./testing/engine-test-layer";
import { type TriggerAdmission, TriggerObservation } from "./trigger-observation";
import { WorkflowRun } from "./workflow-run";

const id = Schema.decodeSync(WorkItemId);
const workflowId = Schema.decodeSync(WorkflowId)("scheduled-workflow");
const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
const operationId = Schema.decodeSync(WorkflowNodeId)("run");
const scheduleEntry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");

const never = Latch.makeUnsafe(false).await;

const runsInFlight = Metric.gauge("cogwork_scheduler_runs_in_flight", {
  description: "Runs currently executing across all workspaces.",
});
const budgetUsed = Metric.gauge("cogwork_scheduler_budget_used", {
  description: "Runs charged against the current UTC day's budget.",
});
const budgetExhaustedTicks = Metric.counter("cogwork_scheduler_budget_exhausted_ticks_total", {
  description: "Scheduler ticks that found eligible work after the daily budget was exhausted.",
});
const jobOutcomes = Metric.counter("cogwork_scheduler_job_outcomes_total", {
  description: "Scheduled jobs completed by outcome.",
});

const workspaceOf = (name: string, concurrency?: number): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  repository: `owner/${name}`,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker: { type: "github" },
  }),
  ...(concurrency === undefined ? {} : { workspaceLimit: concurrency }),
});

const work = (
  n: number,
  stage: LifecycleStage = "triage",
  priorFailures = 0,
  priority: Priority = "medium",
): EligibleWork => ({
  id: id(`#${n}`),
  title: `item ${n}`,
  stage,
  priority,
  priorFailures,
  workContext: {
    reference: { workItem: id(`#${n}`), url: null },
    facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority, pr: null },
  },
});

const candidate = (
  workspace: RegisteredWorkspace,
  item: EligibleWork,
  workspaceLimit: number,
): Scheduler.Candidate => ({
  workspace,
  work: item,
  workspaceLimit,
  keys: [`${workspace.config.name}:ticket:${item.id}`],
  observation: { generation: 1, observedAtMillis: 1 },
});

const stamp = (day: number, generation = 1): Scheduler.TickStamp => ({ day, generation });

describe("Scheduler.seedState", () => {
  const base = { globalLimit: 10, perWorkspaceLimit: 10, dailyBudget: 100 };

  it("supports a running initial state for isolated scheduler layers", () => {
    assert.strictEqual(Scheduler.seedState(base).paused, false);
  });

  it("starts paused when requested", () => {
    assert.strictEqual(Scheduler.seedState({ ...base, startPaused: true }).paused, true);
  });
});

describe("Scheduler.configFromControlStore", () => {
  it("seeds every durable limit and starts every daemon paused", () => {
    const config = Scheduler.configFromControlStore({
      daemonLimits: {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 3,
        dailyBudget: 20,
        revision: 2,
      },
      operationSettings: [],
      connections: [],
      pluginInstalls: [],
      harnessSettings: [],
      contributionSettings: [],
    });

    assert.deepStrictEqual(config, {
      globalLimit: 8,
      perWorkspaceLimit: 3,
      dailyBudget: 20,
      startPaused: true,
    });
    assert.isTrue(Scheduler.seedState(config).paused);
  });
});

describe("Scheduler.plan", () => {
  const wsA = workspaceOf("a");
  const wsB = workspaceOf("b");
  const config = { globalLimit: 10, perWorkspaceLimit: 10, dailyBudget: 100 };

  it("caps total picks at the global limit", () => {
    const candidates = [
      candidate(wsA, work(1), 10),
      candidate(wsB, work(2), 10),
      candidate(wsA, work(3), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 2, perWorkspaceLimit: 2, dailyBudget: 100 },
      stamp(0),
    );
    assert.strictEqual(result.picks.length, 2);
    assert.strictEqual(result.state.global, 2);
  });

  it("caps picks per workspace independently of the global limit", () => {
    const candidates = [candidate(wsA, work(1), 1), candidate(wsA, work(2), 1), candidate(wsB, work(3), 1)];
    const result = Scheduler.plan(candidates, Scheduler.initialState, config, stamp(0));
    assert.strictEqual(result.picks.length, 2);
    assert.deepStrictEqual(
      result.picks.map((pick) => pick.work.id),
      [id("#1"), id("#3")],
    );
  });

  it("orders picks by stage priority under contention", () => {
    const candidates = [
      candidate(wsA, work(1, "implement"), 10),
      candidate(wsA, work(2, "triage"), 10),
      candidate(wsA, work(3, "follow-up"), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 1, perWorkspaceLimit: 1, dailyBudget: 100 },
      stamp(0),
    );
    assert.deepStrictEqual(
      result.picks.map((pick) => pick.work.stage),
      ["follow-up"],
    );
  });

  it("breaks a within-stage tie by priority across workspaces", () => {
    const candidates = [
      candidate(wsA, work(1, "triage", 0, "low"), 10),
      candidate(wsB, work(2, "triage", 0, "urgent"), 10),
      candidate(wsA, work(3, "triage", 0, "medium"), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 1, perWorkspaceLimit: 1, dailyBudget: 100 },
      stamp(0),
    );
    assert.deepStrictEqual(
      result.picks.map((pick) => pick.work.id),
      [id("#2")],
    );
  });

  it("keeps stage primary: a low follow-up outranks an urgent implement", () => {
    const candidates = [
      candidate(wsA, work(1, "implement", 0, "urgent"), 10),
      candidate(wsB, work(2, "follow-up", 0, "low"), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 1, perWorkspaceLimit: 1, dailyBudget: 100 },
      stamp(0),
    );
    assert.deepStrictEqual(
      result.picks.map((pick) => pick.work.stage),
      ["follow-up"],
    );
  });

  it("allows only one in-flight job per shared key", () => {
    const shared = candidate(wsA, work(1), 10);
    const duplicate = { ...candidate(wsA, work(2), 10), keys: shared.keys };
    const result = Scheduler.plan([shared, duplicate], Scheduler.initialState, config, stamp(0));
    assert.strictEqual(result.picks.length, 1);
  });

  it("stops scheduling once the daily budget is spent", () => {
    const candidates = [
      candidate(wsA, work(1), 10),
      candidate(wsB, work(2), 10),
      candidate(wsA, work(3), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 10, perWorkspaceLimit: 10, dailyBudget: 2 },
      stamp(0),
    );
    assert.strictEqual(result.picks.length, 2);
    assert.strictEqual(result.state.budgetUsed, 2);
  });

  it("picks nothing while paused and resumes once unpaused", () => {
    const candidates = [candidate(wsA, work(1), 10)];
    const paused = Scheduler.plan(candidates, { ...Scheduler.initialState, paused: true }, config, stamp(0));
    assert.strictEqual(paused.picks.length, 0);
    const resumed = Scheduler.plan(
      candidates,
      { ...Scheduler.initialState, paused: false },
      config,
      stamp(0),
    );
    assert.strictEqual(resumed.picks.length, 1);
  });

  it("resets a spent budget when the UTC day rolls over", () => {
    const spent: Scheduler.SchedulerState = {
      ...Scheduler.initialState,
      budgetDay: 0,
      budgetUsed: 5,
    };
    const result = Scheduler.plan(
      [candidate(wsA, work(1), 10)],
      spent,
      { globalLimit: 10, perWorkspaceLimit: 10, dailyBudget: 2 },
      stamp(1),
    );
    assert.strictEqual(result.picks.length, 1);
    assert.strictEqual(result.state.budgetDay, 1);
    assert.strictEqual(result.state.budgetUsed, 1);
  });

  it("skips a candidate already acted on in the current generation", () => {
    const only = candidate(wsA, work(1), 10);
    const acted: Scheduler.SchedulerState = {
      ...Scheduler.initialState,
      generation: 4,
      acted: new Set(only.keys),
    };
    const result = Scheduler.plan([only], acted, config, stamp(0, 4));
    assert.strictEqual(result.picks.length, 0);
  });

  it("drops the acted record when a newer generation arrives", () => {
    const only = candidate(wsA, work(1), 10);
    const acted: Scheduler.SchedulerState = {
      ...Scheduler.initialState,
      generation: 4,
      acted: new Set(only.keys),
    };
    const result = Scheduler.plan([only], acted, config, stamp(0, 5));
    assert.strictEqual(result.picks.length, 1);
    assert.strictEqual(result.state.generation, 5);
  });

  it("prunes acted keys that left the snapshot and are not in flight", () => {
    const present = candidate(wsA, work(1), 10);
    const departed = candidate(wsB, work(2), 10);
    const acted: Scheduler.SchedulerState = {
      ...Scheduler.initialState,
      generation: 4,
      acted: new Set([...present.keys, ...departed.keys]),
    };
    const result = Scheduler.plan([present], acted, config, stamp(0, 4));
    assert.deepStrictEqual([...result.state.acted], [...present.keys]);
  });

  it("keeps an acted key that is still in flight after leaving the snapshot", () => {
    const running = candidate(wsA, work(1), 10);
    const acted: Scheduler.SchedulerState = {
      ...Scheduler.initialState,
      generation: 4,
      inflight: new Set(running.keys),
      acted: new Set(running.keys),
    };
    const result = Scheduler.plan([], acted, config, stamp(0, 4));
    assert.deepStrictEqual([...result.state.acted], [...running.keys]);
  });
});

interface SnapshotEntry {
  readonly workspace: RegisteredWorkspace;
  readonly eligible: ReadonlyArray<EligibleWork>;
}

const snapshotOf = (entries: ReadonlyArray<SnapshotEntry>): Reconcile.ReconcileSnapshot => ({
  generation: 1,
  observedAtMillis: 1,
  workspaces: entries.map(({ workspace, eligible }) => ({
    name: workspace.config.name,
    poll: { status: "ok" },
    eligible,
    claimed: [],
    blocked: [],
    needsHuman: [],
    readyToMerge: [],
    observed: [],
    observedCount: 0,
    availability: [],
  })),
});

interface SchedulerProbeState {
  readonly snapshots: Ref.Ref<Reconcile.ReconcileSnapshot>;
  readonly executions: Ref.Ref<ReadonlyArray<string>>;
  readonly workflowAdmissions: Ref.Ref<ReadonlyArray<TriggerAdmission>>;
  readonly workflowExecutions: Ref.Ref<ReadonlyArray<string>>;
  readonly gate: Latch.Latch;
}

class SchedulerProbe extends Context.Service<SchedulerProbe, SchedulerProbeState>()(
  "@cogwork/engine/scheduler.test/SchedulerProbe",
) {}

const probeLayer = (
  entries: ReadonlyArray<SnapshotEntry>,
  workflowAdmissions: ReadonlyArray<TriggerAdmission>,
) =>
  Layer.effect(
    SchedulerProbe,
    Effect.gen(function* () {
      return {
        snapshots: yield* Ref.make(snapshotOf(entries)),
        executions: yield* Ref.make<ReadonlyArray<string>>([]),
        workflowAdmissions: yield* Ref.make(workflowAdmissions),
        workflowExecutions: yield* Ref.make<ReadonlyArray<string>>([]),
        gate: yield* Latch.make(),
      };
    }),
  );

const republish = (probe: SchedulerProbeState) =>
  Ref.update(probe.snapshots, (snapshot) => ({ ...snapshot, generation: snapshot.generation + 1 }));

const workerLayer = Layer.effect(
  Reconcile.ReconcileWorker,
  Effect.map(SchedulerProbe, (probe) => ({
    submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    submitAfterCurrent: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    snapshot: Ref.get(probe.snapshots),
    invalidateAvailability: () => Effect.void,
  })),
);

const registryLayer = (workspaces: ReadonlyArray<RegisteredWorkspace>) =>
  Layer.succeed(Registry.WorkspaceRegistry, Registry.readOnlyRegistry({ workspaces, failures: [] }));

type ExecuteStub = (
  probe: SchedulerProbeState,
  ledger: RunLedger.RunLedgerService,
  workspace: RegisteredWorkspace,
  work: EligibleWork,
) => Effect.Effect<boolean>;

const executorStubLayer = (execute: ExecuteStub) =>
  Layer.effect(
    Executor.Executor,
    Effect.gen(function* () {
      const probe = yield* SchedulerProbe;
      const ledger = yield* RunLedger.RunLedger;
      return {
        execute: (workspace, item) => execute(probe, ledger, workspace, item),
      };
    }),
  );

const recordExecution = (probe: SchedulerProbeState, workspace: RegisteredWorkspace, item: EligibleWork) =>
  Ref.update(probe.executions, (executions) => [...executions, `${workspace.config.name}:${item.id}`]);

const succeed = (
  probe: SchedulerProbeState,
  _ledger: RunLedger.RunLedgerService,
  workspace: RegisteredWorkspace,
  item: EligibleWork,
) => recordExecution(probe, workspace, item).pipe(Effect.map(() => true));

const waitForGate = (
  probe: SchedulerProbeState,
  _ledger: RunLedger.RunLedgerService,
  workspace: RegisteredWorkspace,
  item: EligibleWork,
) =>
  recordExecution(probe, workspace, item).pipe(
    Effect.andThen(probe.gate.await),
    Effect.map(() => true),
  );

const crashIn =
  (workspaceName: WorkspaceId) =>
  (
    probe: SchedulerProbeState,
    _ledger: RunLedger.RunLedgerService,
    workspace: RegisteredWorkspace,
    item: EligibleWork,
  ) =>
    recordExecution(probe, workspace, item).pipe(
      Effect.andThen(workspace.config.name === workspaceName ? Effect.die(new Error("boom")) : Effect.void),
      Effect.map(() => true),
    );

interface SchedulerLayerDependencies {
  readonly registry: ReadonlyArray<RegisteredWorkspace>;
  readonly registryService?: Registry.WorkspaceRegistryService;
  readonly snapshots: ReadonlyArray<SnapshotEntry>;
  readonly execute: ExecuteStub;
  readonly workflowAdmissions?: ReadonlyArray<TriggerAdmission>;
  readonly workflowExecute?: (probe: SchedulerProbeState, admission: TriggerAdmission) => Effect.Effect<void>;
}

const providedRegistryLayer = (deps: SchedulerLayerDependencies) => {
  if (deps.registryService) return Layer.succeed(Registry.WorkspaceRegistry, deps.registryService);
  return registryLayer(deps.registry);
};

const schedulerLayer = (config: Scheduler.SchedulerConfig, deps: SchedulerLayerDependencies) => {
  const engineServices = engineTestLayer();
  const probe = probeLayer(deps.snapshots, deps.workflowAdmissions ?? []);
  return Scheduler.layer(config).pipe(
    Layer.provide(
      Layer.mergeAll(
        providedRegistryLayer(deps),
        workerLayer.pipe(Layer.provide(probe)),
        executorStubLayer(deps.execute).pipe(Layer.provide(Layer.merge(probe, engineServices))),
        Layer.effect(
          TriggerObservation,
          Effect.map(SchedulerProbe, (state) => ({
            eligible: Ref.get(state.workflowAdmissions),
            changes: Stream.empty,
            health: Effect.succeed([]),
            catalog: [],
            refresh: Effect.void,
          })),
        ).pipe(Layer.provide(probe)),
        Layer.effect(
          WorkflowRun,
          Effect.map(SchedulerProbe, (state) => ({
            execute: (admission: TriggerAdmission) => deps.workflowExecute?.(state, admission) ?? Effect.void,
          })),
        ).pipe(Layer.provide(probe)),
        engineServices,
      ),
    ),
    Layer.provideMerge(probe),
    Layer.provideMerge(engineServices),
  );
};

const workflowAdmission = (instantMillis: number): TriggerAdmission => {
  const item = { _tag: "ScheduleInstant", workflow: workflowId, instantMillis } as const;
  return {
    event: {
      key: item,
      revision: String(instantMillis),
      cause: { _tag: "Unknown" },
      atMillis: instantMillis,
      entry: scheduleEntry,
      workspace: null,
    },
    subscription: {
      workflow: workflowId,
      trigger: triggerId,
      operation: operationId,
      entry: scheduleEntry,
      parameters: [],
      workspaces: [],
      catchUp: { since: 0 },
    },
    lineage: {
      root: Schema.decodeSync(LineageId)(keyOf(item)),
      parent: null,
      hop: 0,
    },
  };
};

describe("Scheduler.tick", () => {
  const wsA = workspaceOf("a", 2);
  const wsB = workspaceOf("b", 2);

  it.effect("reserves Workflow admissions under the shared concurrency and budget limits", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const admissions = [workflowAdmission(1_000), workflowAdmission(2_000), workflowAdmission(3_000)];

      assert.strictEqual(yield* scheduler.tick(), 1);
      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.strictEqual((yield* scheduler.stats).global, 1);

      yield* probe.gate.open;
      yield* scheduler.awaitIdle;
      yield* Ref.set(probe.workflowAdmissions, admissions.slice(0, 1));
      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 0);
      yield* Ref.set(probe.workflowAdmissions, admissions.slice(1));
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
      yield* Ref.set(probe.workflowAdmissions, admissions.slice(2));

      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.strictEqual((yield* scheduler.stats).budgetUsed, 2);
      assert.deepStrictEqual(yield* Ref.get(probe.workflowExecutions), ["1000", "2000"]);
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 1, perWorkspaceLimit: 1, dailyBudget: 2 },
          {
            registry: [],
            snapshots: [],
            execute: succeed,
            workflowAdmissions: [
              workflowAdmission(1_000),
              workflowAdmission(2_000),
              workflowAdmission(3_000),
            ],
            workflowExecute: (probe, admission) =>
              Ref.update(probe.workflowExecutions, (executions) => [
                ...executions,
                admission.event.revision,
              ]).pipe(Effect.andThen(probe.gate.await)),
          },
        ),
      ),
    ),
  );

  it.effect("isolates a crashing Workflow Run from other scheduled work", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const success = Metric.withAttributes(jobOutcomes, { outcome: "success" });
      const failure = Metric.withAttributes(jobOutcomes, { outcome: "failure" });
      const before = {
        success: (yield* Metric.value(success)).count,
        failure: (yield* Metric.value(failure)).count,
      };

      assert.strictEqual(yield* scheduler.tick(), 2);
      yield* Effect.yieldNow;
      yield* probe.gate.open;
      yield* scheduler.awaitIdle;

      assert.include(yield* Ref.get(probe.workflowExecutions), "2000:finished");
      assert.strictEqual((yield* scheduler.stats).global, 0);
      assert.strictEqual((yield* Metric.value(success)).count, before.success + 1);
      assert.strictEqual((yield* Metric.value(failure)).count, before.failure + 1);
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 2, perWorkspaceLimit: 1, dailyBudget: 2 },
          {
            registry: [],
            snapshots: [],
            execute: succeed,
            workflowAdmissions: [workflowAdmission(1_000), workflowAdmission(2_000)],
            workflowExecute: (probe, admission) => {
              const revision = admission.event.revision;
              const execution = Ref.update(probe.workflowExecutions, (executions) => [
                ...executions,
                `${revision}:started`,
              ]);
              if (revision === "1000") return execution.pipe(Effect.andThen(Effect.die("boom")));
              return execution.pipe(
                Effect.andThen(probe.gate.await),
                Effect.andThen(
                  Ref.update(probe.workflowExecutions, (executions) => [
                    ...executions,
                    `${revision}:finished`,
                  ]),
                ),
              );
            },
          },
        ),
      ),
    ),
  );

  it.effect("enforces global and per-workspace caps across two workspaces", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;

      assert.strictEqual(yield* scheduler.tick(), 3);
      const afterFirst = yield* scheduler.stats;
      assert.strictEqual(afterFirst.global, 3);
      assert.strictEqual(afterFirst.perWorkspace.get(wsA.config.name), 2);
      assert.strictEqual(yield* scheduler.tick(), 0);

      yield* probe.gate.open;
      yield* scheduler.awaitIdle;
      assert.strictEqual((yield* scheduler.stats).global, 0);
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 3, perWorkspaceLimit: 3, dailyBudget: 100 },
          {
            registry: [wsA, wsB],
            snapshots: [
              { workspace: wsA, eligible: [work(1), work(2), work(3)] },
              { workspace: wsB, eligible: [work(4), work(5), work(6)] },
            ],
            execute: waitForGate,
          },
        ),
      ),
    ),
  );

  it.effect("isolates a crashing workspace from the others", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      assert.strictEqual(yield* scheduler.tick(), 2);
      yield* scheduler.awaitIdle;

      const ran = yield* Ref.get(probe.executions);
      assert.isTrue(ran.includes(`${wsB.config.name}:${id("#2")}`));
      assert.strictEqual((yield* scheduler.stats).global, 0);

      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 2);
      yield* scheduler.awaitIdle;
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 100 },
          {
            registry: [wsA, wsB],
            snapshots: [
              { workspace: wsA, eligible: [work(1)] },
              { workspace: wsB, eligible: [work(2)] },
            ],
            execute: crashIn(wsA.config.name),
          },
        ),
      ),
    ),
  );

  it.effect("stops starting sessions once the daily budget is exhausted and resets by UTC day", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const exhaustedBefore = (yield* Metric.value(budgetExhaustedTicks)).count;

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
      assert.strictEqual((yield* Metric.value(runsInFlight)).value, 0);
      assert.strictEqual((yield* Metric.value(budgetUsed)).value, 1);

      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.strictEqual((yield* Metric.value(budgetExhaustedTicks)).count, exhaustedBefore + 1);

      yield* TestClock.adjust("25 hours");
      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 1 },
          { registry: [wsA], snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: succeed },
        ),
      ),
    ),
  );

  it.effect("records scheduler job exits without counting drain interruption as failure", () =>
    Effect.gen(function* () {
      const success = Metric.withAttributes(jobOutcomes, { outcome: "success" });
      const failure = Metric.withAttributes(jobOutcomes, { outcome: "failure" });
      const interrupt = Metric.withAttributes(jobOutcomes, { outcome: "interrupt" });
      const before = {
        success: (yield* Metric.value(success)).count,
        failure: (yield* Metric.value(failure)).count,
        interrupt: (yield* Metric.value(interrupt)).count,
      };
      const runSchedulerToIdle = (execute: ExecuteStub) =>
        Scheduler.Scheduler.pipe(
          Effect.flatMap((scheduler) => scheduler.tick().pipe(Effect.andThen(scheduler.awaitIdle))),
          Effect.provide(
            schedulerLayer(
              { globalLimit: 1, perWorkspaceLimit: 1, dailyBudget: 10 },
              { registry: [wsA], snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute },
            ),
          ),
        );

      yield* runSchedulerToIdle(succeed);
      yield* runSchedulerToIdle(crashIn(wsA.config.name));
      yield* Scheduler.Scheduler.pipe(
        Effect.flatMap((scheduler) =>
          scheduler.tick().pipe(Effect.andThen(scheduler.drain({ graceMillis: 10_000, abort: Effect.void }))),
        ),
        Effect.provide(
          schedulerLayer(
            { globalLimit: 2, perWorkspaceLimit: 2, dailyBudget: 10 },
            {
              registry: [wsA],
              snapshots: [{ workspace: wsA, eligible: [work(1), work(2)] }],
              execute: waitForGate,
            },
          ),
        ),
      );

      assert.strictEqual((yield* Metric.value(success)).count, before.success + 1);
      assert.strictEqual((yield* Metric.value(failure)).count, before.failure + 1);
      assert.strictEqual((yield* Metric.value(interrupt)).count, before.interrupt + 2);
      assert.strictEqual((yield* Metric.value(runsInFlight)).value, 0);
    }),
  );

  it.effect("picks an item once per generation and again once a newer snapshot lands", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
      assert.strictEqual((yield* scheduler.stats).global, 0);

      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.strictEqual((yield* Ref.get(probe.executions)).length, 1);

      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;
      assert.strictEqual((yield* Ref.get(probe.executions)).length, 2);
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 100 },
          { registry: [wsA], snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: succeed },
        ),
      ),
    ),
  );

  it.effect("holds a run that outlives a generation boundary behind its reservation", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;

      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 0);
      assert.strictEqual((yield* scheduler.stats).global, 1);

      yield* probe.gate.open;
      yield* scheduler.awaitIdle;
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 100 },
          { registry: [wsA], snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: waitForGate },
        ),
      ),
    ),
  );

  it.effect("lets an in-flight Run settle after its workspace leaves the registry", () => {
    const state = Ref.makeUnsafe<Registry.RegistryState>({ workspaces: [wsA], failures: [] });
    const registry: Registry.WorkspaceRegistryService = {
      state: Ref.get(state),
      refresh: Ref.get(state),
    };
    const runId = Schema.decodeSync(RunId)("deregistered-workspace");
    const harness = Schema.decodeSync(HarnessName)("cursor");
    const finishAfterGate: ExecuteStub = (probe, ledger, workspace, item) =>
      recordExecution(probe, workspace, item).pipe(
        Effect.andThen(
          ledger.insertRun({
            id: runId,
            workspace: workspace.config.name,
            workItem: item.id,
            stage: item.stage,
            harness,
            branch: null,
            session: null,
            usage: null,
            status: "running",
            startedAtMillis: 0,
            endedAtMillis: null,
          }),
        ),
        Effect.andThen(probe.gate.await),
        Effect.andThen(ledger.updateRun(runId, { status: "succeeded", usage: null, endedAtMillis: 1 })),
        Effect.map(() => true),
      );
    return Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* Effect.yieldNow;

      yield* Ref.set(state, Registry.emptyRegistry);
      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 0);

      yield* probe.gate.open;
      yield* scheduler.awaitIdle;
      assert.strictEqual((yield* ledger.getRun(runId))?.status, "succeeded");
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 100 },
          {
            registry: [],
            registryService: registry,
            snapshots: [{ workspace: wsA, eligible: [work(1)] }],
            execute: finishAfterGate,
          },
        ),
      ),
    );
  });

  it.effect("reports an item in flight from reservation through executor completion", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const item = work(1);

      assert.isFalse(yield* scheduler.isInFlight(wsA, item.id));
      assert.strictEqual(yield* scheduler.tick(), 1);
      assert.isTrue(yield* scheduler.isInFlight(wsA, item.id));

      yield* probe.gate.open;
      yield* scheduler.awaitIdle;
      assert.isFalse(yield* scheduler.isInFlight(wsA, item.id));
    }).pipe(
      Effect.provide(
        schedulerLayer(
          { globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 100 },
          { registry: [wsA], snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: waitForGate },
        ),
      ),
    ),
  );
});

describe("Scheduler.drain", () => {
  const wsA = workspaceOf("a", 2);
  const oneHour = 3_600_000;
  const runId = Schema.decodeSync(RunId);
  const harness = Schema.decodeSync(HarnessName)("cursor");

  const runRecord = (name: string, startedAtMillis: number): RunRecord => ({
    id: runId(name),
    workspace: wsA.config.name,
    workItem: id("#1"),
    stage: "triage",
    harness,
    branch: null,
    session: null,
    usage: null,
    status: "running",
    startedAtMillis,
    endedAtMillis: null,
  });

  const statusOf = (ledger: RunLedger.RunLedgerService, name: string) =>
    Effect.map(ledger.getRun(runId(name)), (run) => run?.status ?? null);

  const finishInside = (name: string) => (probe: SchedulerProbeState, ledger: RunLedger.RunLedgerService) =>
    ledger.insertRun(runRecord(name, 0)).pipe(
      Effect.andThen(probe.gate.await),
      Effect.andThen(
        ledger.updateRun(runId(name), {
          status: "succeeded",
          usage: null,
          endedAtMillis: 10_000,
        }),
      ),
      Effect.map(() => true),
    );

  const neverEnds = (name: string) => (_probe: SchedulerProbeState, ledger: RunLedger.RunLedgerService) =>
    ledger.insertRun(runRecord(name, 0)).pipe(
      Effect.andThen(never),
      Effect.map(() => true),
    );

  const draining = (deps: {
    readonly snapshots: ReadonlyArray<SnapshotEntry>;
    readonly execute: ExecuteStub;
    readonly workflowAdmissions?: ReadonlyArray<TriggerAdmission>;
    readonly workflowExecute?: (
      probe: SchedulerProbeState,
      admission: TriggerAdmission,
    ) => Effect.Effect<void>;
  }) =>
    schedulerLayer({ globalLimit: 5, perWorkspaceLimit: 5, dailyBudget: 100 }, { registry: [wsA], ...deps });

  it.effect("lets a run that finishes inside the grace window record its own outcome", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      const ledger = yield* RunLedger.RunLedger;
      yield* scheduler.tick();

      const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
      yield* TestClock.adjust("10 seconds");
      yield* probe.gate.open;

      assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 0 });
      assert.strictEqual(yield* statusOf(ledger, "inside"), "succeeded");
    }).pipe(
      Effect.provide(
        draining({ snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: finishInside("inside") }),
      ),
    ),
  );

  it.effect("interrupts a run still going when the grace window closes", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const ledger = yield* RunLedger.RunLedger;
      yield* scheduler.tick();

      const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
      yield* TestClock.adjust("1 hour");

      assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 1 });
      assert.strictEqual(yield* statusOf(ledger, "outlasts"), "interrupted");
      assert.strictEqual((yield* scheduler.stats).global, 0);
    }).pipe(
      Effect.provide(
        draining({ snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: neverEnds("outlasts") }),
      ),
    ),
  );

  it.effect("announces each interrupted run on the bus as the grace window closes", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      yield* scheduler.tick();

      const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
      yield* TestClock.adjust("1 hour");
      yield* Fiber.join(drain);

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(
          (event) => DaemonEvent.guards.RunChanged(event) && event.run.status === "interrupted",
        ),
        Stream.runCollect,
      );
      const changed = [...events].flatMap((event) =>
        DaemonEvent.guards.RunChanged(event) && event.run.status === "interrupted" ? [event.run] : [],
      );
      assert.deepStrictEqual(
        changed.map((run) => run.status),
        ["interrupted"],
      );
      assert.strictEqual(changed.at(0)?.id, runId("outlasts"));
    }).pipe(
      Effect.provide(
        draining({ snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: neverEnds("outlasts") }),
      ),
      Effect.scoped,
    ),
  );

  it.effect("ends the wait as soon as a second stop signal arrives", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const ledger = yield* RunLedger.RunLedger;
      const abort = yield* Latch.make();
      yield* scheduler.tick();

      const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: abort.await }));
      yield* abort.open;

      assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 1 });
      assert.strictEqual(yield* statusOf(ledger, "aborted"), "interrupted");
    }).pipe(
      Effect.provide(
        draining({ snapshots: [{ workspace: wsA, eligible: [work(1)] }], execute: neverEnds("aborted") }),
      ),
    ),
  );

  it.effect("leaves a run from an earlier daemon life alone", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord("earlier-life", -1));
      yield* scheduler.drain({ graceMillis: oneHour, abort: never });
      assert.strictEqual(yield* statusOf(ledger, "earlier-life"), "running");
    }).pipe(Effect.provide(draining({ snapshots: [], execute: succeed }))),
  );

  it.effect("picks no further candidates once a drain has started", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const probe = yield* SchedulerProbe;
      yield* scheduler.drain({ graceMillis: oneHour, abort: never });

      yield* republish(probe);
      assert.strictEqual(yield* scheduler.tick(), 0);
    }).pipe(
      Effect.provide(
        draining({
          snapshots: [{ workspace: wsA, eligible: [work(1)] }],
          execute: succeed,
          workflowAdmissions: [workflowAdmission(1_000)],
        }),
      ),
    ),
  );
});
