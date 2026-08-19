import {
  HarnessName,
  type LifecycleStage,
  type Priority,
  RunId,
  type RunRecord,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { EligibleWork } from "./classify";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import type { RegisteredWorkspace } from "./projector";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";

const id = Schema.decodeSync(WorkItemId);

const never = Latch.makeUnsafe(false).await;

type ExecuteFn = (workspace: RegisteredWorkspace, work: EligibleWork) => Effect.Effect<boolean>;

const workspaceOf = (name: string, concurrency?: number): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker: { type: "github", repo: `owner/${name}`, actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    playbook: { triage: { enabled: true } },
    ...(concurrency === undefined ? {} : { concurrency }),
  }),
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
});

const stamp = (day: number, generation = 1): Scheduler.TickStamp => ({ day, generation });

describe("Scheduler.plan", () => {
  const wsA = workspaceOf("a");
  const wsB = workspaceOf("b");
  const config = { globalLimit: 10, dailyBudget: 100 };

  it("caps total picks at the global limit", () => {
    const candidates = [
      candidate(wsA, work(1), 10),
      candidate(wsB, work(2), 10),
      candidate(wsA, work(3), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 2, dailyBudget: 100 },
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
      candidate(wsA, work(1, "verify"), 10),
      candidate(wsA, work(2, "triage"), 10),
      candidate(wsA, work(3, "follow-up"), 10),
    ];
    const result = Scheduler.plan(
      candidates,
      Scheduler.initialState,
      { globalLimit: 1, dailyBudget: 100 },
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
      { globalLimit: 1, dailyBudget: 100 },
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
      { globalLimit: 1, dailyBudget: 100 },
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
      { globalLimit: 10, dailyBudget: 2 },
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
      { globalLimit: 10, dailyBudget: 2 },
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
  workspaces: entries.map(({ workspace, eligible }) => ({
    name: workspace.config.name,
    poll: { status: "ok" },
    eligible,
    claimed: [],
    blocked: [],
    needsHuman: [],
    observed: [],
  })),
});

const snapshotRef = (entries: ReadonlyArray<SnapshotEntry>) => Ref.make(snapshotOf(entries));

const republish = (snapshots: Ref.Ref<Reconcile.ReconcileSnapshot>) =>
  Ref.update(snapshots, (snapshot) => ({ ...snapshot, generation: snapshot.generation + 1 }));

const workerLayer = (snapshots: Ref.Ref<Reconcile.ReconcileSnapshot>) =>
  Layer.succeed(Reconcile.ReconcileWorker, {
    submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    snapshot: Ref.get(snapshots),
  });

const registryLayer = (workspaces: ReadonlyArray<RegisteredWorkspace>) =>
  Layer.succeed(Registry.WorkspaceRegistry, { workspaces, failures: [] });

const schedulerLayer = (
  config: Scheduler.SchedulerConfig,
  deps: {
    readonly registry: ReadonlyArray<RegisteredWorkspace>;
    readonly snapshots: Ref.Ref<Reconcile.ReconcileSnapshot>;
    readonly execute: ExecuteFn;
    readonly ledger?: RunLedger.RunLedgerService;
  },
) => {
  const bus = DaemonEventBus.layer;
  const core = deps.ledger ? Layer.succeed(RunLedger.CoreRunLedger, deps.ledger) : RunLedger.layerMemoryCore;
  const runLedger = RunLedger.publishingLayer.pipe(Layer.provide(core), Layer.provide(bus));
  return Scheduler.layer(config).pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer(deps.registry),
        workerLayer(deps.snapshots),
        Layer.succeed(Executor.Executor, { execute: deps.execute }),
        runLedger,
      ),
    ),
    Layer.provideMerge(runLedger),
    Layer.provideMerge(bus),
  );
};

describe("Scheduler.tick", () => {
  const wsA = workspaceOf("a", 2);
  const wsB = workspaceOf("b", 2);

  it.effect("enforces global and per-workspace caps across two workspaces", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Ref.make<ReadonlyArray<string>>([]);
      const execute: ExecuteFn = (workspace, item) =>
        Ref.update(started, (xs) => [...xs, `${workspace.config.name}:${item.id}`]).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.map(() => true),
        );
      const snapshots = yield* snapshotRef([
        { workspace: wsA, eligible: [work(1), work(2), work(3)] },
        { workspace: wsB, eligible: [work(4), work(5), work(6)] },
      ]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        const first = yield* scheduler.tick();
        assert.strictEqual(first.length, 3);
        const afterFirst = yield* scheduler.stats;
        assert.strictEqual(afterFirst.global, 3);
        assert.strictEqual(afterFirst.perWorkspace.get(wsA.config.name), 2);

        const second = yield* scheduler.tick();
        assert.strictEqual(second.length, 0);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.awaitAll(first);
        const drained = yield* scheduler.stats;
        assert.strictEqual(drained.global, 0);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 3, dailyBudget: 100 }, { registry: [wsA, wsB], snapshots, execute }),
        ),
      );
    }),
  );

  it.effect("isolates a crashing workspace from the others", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<string>>([]);
      const execute: ExecuteFn = (workspace, item) =>
        Ref.update(started, (xs) => [...xs, `${workspace.config.name}:${item.id}`]).pipe(
          Effect.andThen(
            workspace.config.name === wsA.config.name ? Effect.die(new Error("boom")) : Effect.succeed(true),
          ),
        );
      const snapshots = yield* snapshotRef([
        { workspace: wsA, eligible: [work(1)] },
        { workspace: wsB, eligible: [work(2)] },
      ]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        const dispatched = yield* scheduler.tick();
        yield* Fiber.awaitAll(dispatched);

        const ran = yield* Ref.get(started);
        assert.isTrue(ran.includes(`${wsB.config.name}:${id("#2")}`));
        const drained = yield* scheduler.stats;
        assert.strictEqual(drained.global, 0);

        yield* republish(snapshots);
        const again = yield* scheduler.tick();
        assert.strictEqual(again.length, 2);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 4, dailyBudget: 100 }, { registry: [wsA, wsB], snapshots, execute }),
        ),
      );
    }),
  );

  it.effect("stops starting sessions once the daily budget is exhausted and resets by UTC day", () =>
    Effect.gen(function* () {
      const execute: ExecuteFn = () => Effect.succeed(true);
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        const first = yield* scheduler.tick();
        yield* Fiber.awaitAll(first);
        assert.strictEqual(first.length, 1);

        yield* republish(snapshots);
        const exhausted = yield* scheduler.tick();
        assert.strictEqual(exhausted.length, 0);

        yield* TestClock.adjust("25 hours");
        yield* republish(snapshots);
        const nextDay = yield* scheduler.tick();
        yield* Fiber.awaitAll(nextDay);
        assert.strictEqual(nextDay.length, 1);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 5, dailyBudget: 1 }, { registry: [wsA], snapshots, execute }),
        ),
      );
    }),
  );

  it.effect("picks an item once per generation and again once a newer snapshot lands", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const execute: ExecuteFn = () => Ref.update(runs, (n) => n + 1).pipe(Effect.map(() => true));
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        const first = yield* scheduler.tick();
        yield* Fiber.awaitAll(first);
        assert.strictEqual(first.length, 1);
        assert.strictEqual((yield* scheduler.stats).global, 0);

        const repeat = yield* scheduler.tick();
        assert.strictEqual(repeat.length, 0);
        assert.strictEqual(yield* Ref.get(runs), 1);

        yield* republish(snapshots);
        const refreshed = yield* scheduler.tick();
        yield* Fiber.awaitAll(refreshed);
        assert.strictEqual(refreshed.length, 1);
        assert.strictEqual(yield* Ref.get(runs), 2);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 5, dailyBudget: 100 }, { registry: [wsA], snapshots, execute }),
        ),
      );
    }),
  );

  it.effect("holds a run that outlives a generation boundary behind its reservation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const execute: ExecuteFn = () => Deferred.await(gate).pipe(Effect.map(() => true));
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        const first = yield* scheduler.tick();
        assert.strictEqual(first.length, 1);

        yield* republish(snapshots);
        const duringRun = yield* scheduler.tick();
        assert.strictEqual(duringRun.length, 0);
        assert.strictEqual((yield* scheduler.stats).global, 1);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.awaitAll(first);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 5, dailyBudget: 100 }, { registry: [wsA], snapshots, execute }),
        ),
      );
    }),
  );

  it.effect("starts paused when configured and picks nothing until it is resumed", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const execute: ExecuteFn = () => Ref.update(runs, (n) => n + 1).pipe(Effect.map(() => true));
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        assert.isTrue((yield* scheduler.stats).paused);
        const held = yield* scheduler.tick();
        assert.strictEqual(held.length, 0);
        assert.strictEqual(yield* Ref.get(runs), 0);

        yield* scheduler.setScheduling("running");
        yield* republish(snapshots);
        const resumed = yield* scheduler.tick();
        yield* Fiber.awaitAll(resumed);
        assert.strictEqual(resumed.length, 1);
        assert.strictEqual(yield* Ref.get(runs), 1);
      }).pipe(
        Effect.provide(
          schedulerLayer(
            { globalLimit: 5, dailyBudget: 100, startPaused: true },
            { registry: [wsA], snapshots, execute },
          ),
        ),
      );
    }),
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

  const neverEnds =
    (ledger: RunLedger.RunLedgerService, name: string): ExecuteFn =>
    () =>
      ledger.insertRun(runRecord(name, 0)).pipe(
        Effect.andThen(never),
        Effect.map(() => true),
      );

  const draining = (deps: {
    readonly snapshots: Ref.Ref<Reconcile.ReconcileSnapshot>;
    readonly execute: ExecuteFn;
    readonly ledger?: RunLedger.RunLedgerService;
  }) => schedulerLayer({ globalLimit: 5, dailyBudget: 100 }, { registry: [wsA], ...deps });

  it.effect("lets a run that finishes inside the grace window record its own outcome", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.makeMemory;
      const gate = yield* Latch.make();
      const execute: ExecuteFn = () =>
        ledger.insertRun(runRecord("inside", 0)).pipe(
          Effect.andThen(gate.await),
          Effect.andThen(
            ledger.updateRun(runId("inside"), {
              status: "succeeded",
              usage: null,
              endedAtMillis: 10_000,
            }),
          ),
          Effect.map(() => true),
        );
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.tick();

        const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
        yield* TestClock.adjust("10 seconds");
        yield* gate.open;

        assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 0 });
        assert.strictEqual(yield* statusOf(ledger, "inside"), "succeeded");
      }).pipe(Effect.provide(draining({ snapshots, execute, ledger })));
    }),
  );

  it.effect("interrupts a run still going when the grace window closes", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.makeMemory;
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.tick();

        const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
        yield* TestClock.adjust("1 hour");

        assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 1 });
        assert.strictEqual(yield* statusOf(ledger, "outlasts"), "interrupted");
        assert.strictEqual((yield* scheduler.stats).global, 0);
      }).pipe(Effect.provide(draining({ snapshots, execute: neverEnds(ledger, "outlasts"), ledger })));
    }),
  );

  it.effect("announces each interrupted run on the bus as the grace window closes", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.makeMemory;
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        yield* scheduler.tick();

        const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: never }));
        yield* TestClock.adjust("1 hour");
        yield* Fiber.join(drain);

        const events = yield* Stream.fromSubscription(subscription).pipe(
          Stream.takeUntil((event) => event._tag === "RunChanged" && event.run.status === "interrupted"),
          Stream.runCollect,
        );
        const changed = [...events].flatMap((event) => (event._tag === "RunChanged" ? [event.run] : []));
        assert.deepStrictEqual(
          changed.map((run) => run.status),
          ["interrupted"],
        );
        assert.strictEqual(changed.at(0)?.id, runId("outlasts"));
      }).pipe(
        Effect.provide(draining({ snapshots, execute: neverEnds(ledger, "outlasts"), ledger })),
        Effect.scoped,
      );
    }),
  );

  it.effect("ends the wait as soon as a second stop signal arrives", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.makeMemory;
      const abort = yield* Latch.make();
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.tick();

        const drain = yield* Effect.forkChild(scheduler.drain({ graceMillis: oneHour, abort: abort.await }));
        yield* abort.open;

        assert.deepStrictEqual(yield* Fiber.join(drain), { inFlight: 1, interrupted: 1 });
        assert.strictEqual(yield* statusOf(ledger, "aborted"), "interrupted");
      }).pipe(Effect.provide(draining({ snapshots, execute: neverEnds(ledger, "aborted"), ledger })));
    }),
  );

  it.effect("leaves a run from an earlier daemon life alone", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(runRecord("earlier-life", 0));
      yield* TestClock.adjust("1 minute");
      const snapshots = yield* snapshotRef([]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.drain({ graceMillis: oneHour, abort: never });
        assert.strictEqual(yield* statusOf(ledger, "earlier-life"), "running");
      }).pipe(Effect.provide(draining({ snapshots, execute: () => Effect.succeed(true), ledger })));
    }),
  );

  it.effect("picks no further candidates once a drain has started", () =>
    Effect.gen(function* () {
      const snapshots = yield* snapshotRef([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.drain({ graceMillis: oneHour, abort: never });

        yield* republish(snapshots);
        assert.strictEqual((yield* scheduler.tick()).length, 0);
      }).pipe(Effect.provide(draining({ snapshots, execute: () => Effect.succeed(true) })));
    }),
  );
});
