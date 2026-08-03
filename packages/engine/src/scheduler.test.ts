import { type LifecycleStage, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { EligibleWork } from "./classify";
import { recoveryReason } from "./comments";
import * as Executor from "./Executor";
import type { RegisteredWorkspace } from "./projector";
import * as Reconcile from "./Reconcile";
import * as Registry from "./Registry";
import * as RunLedger from "./RunLedger";
import * as Scheduler from "./Scheduler";
import type { ObservedItem } from "./WorkSource";
import { WorkSource, type WorkSourceService } from "./WorkSource";

const id = Schema.decodeSync(WorkItemId);

type ExecuteFn = (workspace: RegisteredWorkspace, work: EligibleWork) => Effect.Effect<boolean>;

const workspaceOf = (name: string, concurrency?: number): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    workSource: { type: "github", repo: `owner/${name}`, botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    playbook: { triage: { enabled: true } },
    ...(concurrency === undefined ? {} : { concurrency }),
  }),
});

const work = (n: number, stage: LifecycleStage = "triage", priorFailures = 0): EligibleWork => ({
  id: id(`#${n}`),
  title: `item ${n}`,
  stage,
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
      0,
    );
    assert.strictEqual(result.picks.length, 2);
    assert.strictEqual(result.state.global, 2);
  });

  it("caps picks per workspace independently of the global limit", () => {
    const candidates = [candidate(wsA, work(1), 1), candidate(wsA, work(2), 1), candidate(wsB, work(3), 1)];
    const result = Scheduler.plan(candidates, Scheduler.initialState, config, 0);
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
      0,
    );
    assert.deepStrictEqual(
      result.picks.map((pick) => pick.work.stage),
      ["follow-up"],
    );
  });

  it("allows only one in-flight job per shared key", () => {
    const shared = candidate(wsA, work(1), 10);
    const duplicate = { ...candidate(wsA, work(2), 10), keys: shared.keys };
    const result = Scheduler.plan([shared, duplicate], Scheduler.initialState, config, 0);
    assert.strictEqual(result.picks.length, 1);
  });

  it("stops scheduling once the daily budget is spent", () => {
    const candidates = [
      candidate(wsA, work(1), 10),
      candidate(wsB, work(2), 10),
      candidate(wsA, work(3), 10),
    ];
    const result = Scheduler.plan(candidates, Scheduler.initialState, { globalLimit: 10, dailyBudget: 2 }, 0);
    assert.strictEqual(result.picks.length, 2);
    assert.strictEqual(result.state.budgetUsed, 2);
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
      1,
    );
    assert.strictEqual(result.picks.length, 1);
    assert.strictEqual(result.state.budgetDay, 1);
    assert.strictEqual(result.state.budgetUsed, 1);
  });
});

const snapshotOf = (
  entries: ReadonlyArray<{
    readonly workspace: RegisteredWorkspace;
    readonly eligible: ReadonlyArray<EligibleWork>;
  }>,
): Reconcile.ReconcileSnapshot => ({
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

const workerLayer = (snapshot: Reconcile.ReconcileSnapshot) =>
  Layer.succeed(Reconcile.ReconcileWorker, {
    submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    snapshot: Effect.succeed(snapshot),
  });

const registryLayer = (workspaces: ReadonlyArray<RegisteredWorkspace>) =>
  Layer.succeed(Registry.WorkspaceRegistry, { workspaces, failures: [] });

const workSourceStub = (service: Partial<WorkSourceService>) =>
  Layer.succeed(WorkSource, {
    observe: () => Effect.succeed([]),
    claim: () => Effect.void,
    release: () => Effect.void,
    recordAttempt: () => Effect.void,
    recordFollowUp: () => Effect.void,
    note: () => Effect.void,
    setRoles: () => Effect.void,
    ...service,
  });

const schedulerLayer = (
  config: Scheduler.SchedulerConfig,
  deps: {
    readonly registry: ReadonlyArray<RegisteredWorkspace>;
    readonly snapshot: Reconcile.ReconcileSnapshot;
    readonly execute: ExecuteFn;
    readonly workSource?: Partial<WorkSourceService>;
  },
) =>
  Scheduler.layer(config).pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer(deps.registry),
        workerLayer(deps.snapshot),
        Layer.succeed(Executor.Executor, { execute: deps.execute }),
        workSourceStub(deps.workSource ?? {}),
        RunLedger.layerMemory,
      ),
    ),
  );

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
      const snapshot = snapshotOf([
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
          schedulerLayer({ globalLimit: 3, dailyBudget: 100 }, { registry: [wsA, wsB], snapshot, execute }),
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
      const snapshot = snapshotOf([
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

        const again = yield* scheduler.tick();
        assert.strictEqual(again.length, 2);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 4, dailyBudget: 100 }, { registry: [wsA, wsB], snapshot, execute }),
        ),
      );
    }),
  );

  it.effect("stops starting sessions once the daily budget is exhausted and resets by UTC day", () =>
    Effect.gen(function* () {
      const execute: ExecuteFn = () => Effect.succeed(true);
      const snapshot = snapshotOf([{ workspace: wsA, eligible: [work(1)] }]);
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;

        const first = yield* scheduler.tick();
        yield* Fiber.awaitAll(first);
        assert.strictEqual(first.length, 1);

        const exhausted = yield* scheduler.tick();
        assert.strictEqual(exhausted.length, 0);

        yield* TestClock.adjust("25 hours");
        const nextDay = yield* scheduler.tick();
        yield* Fiber.awaitAll(nextDay);
        assert.strictEqual(nextDay.length, 1);
      }).pipe(
        Effect.provide(
          schedulerLayer({ globalLimit: 5, dailyBudget: 1 }, { registry: [wsA], snapshot, execute }),
        ),
      );
    }),
  );
});

describe("Scheduler.recover", () => {
  const wsA = workspaceOf("a");
  const claimedByUs: ObservedItem = {
    id: id("#1"),
    title: "ours",
    roles: ["ready-for-agent"],
    claimLabeled: true,
    claim: { by: "clanker-bot", claimedAtMillis: 1, stage: "implement" },
    attempts: [],
    pr: null,
    openBlockers: 0,
  };
  const claimedByOther: ObservedItem = {
    id: id("#2"),
    title: "theirs",
    roles: [],
    claimLabeled: true,
    claim: { by: "someone-else", claimedAtMillis: 1 },
    attempts: [],
    pr: null,
    openBlockers: 0,
  };
  const unclaimed: ObservedItem = {
    id: id("#3"),
    title: "free",
    roles: ["needs-triage"],
    claimLabeled: false,
    claim: null,
    attempts: [],
    pr: null,
    openBlockers: 0,
  };

  it.effect("releases only stale claims left by this daemon and records a recovery attempt", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<{ item: string; reason?: string }>>([]);
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const workSource: Partial<WorkSourceService> = {
        observe: () => Effect.succeed([claimedByUs, claimedByOther, unclaimed]),
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        recordAttempt: (_workspace, itemId, _attempt, reason) =>
          Ref.update(attempts, (xs) => [...xs, { item: itemId, reason }]),
        note: (_workspace, _itemId, detail) => Ref.update(notes, (xs) => [...xs, detail]),
      };
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.recover();
        assert.deepStrictEqual(yield* Ref.get(released), [id("#1")]);
        assert.deepStrictEqual(yield* Ref.get(attempts), [{ item: id("#1"), reason: recoveryReason }]);
        assert.deepStrictEqual(yield* Ref.get(notes), []);
      }).pipe(
        Effect.provide(
          schedulerLayer(
            { globalLimit: 4, dailyBudget: 100 },
            { registry: [wsA], snapshot: snapshotOf([]), execute: () => Effect.succeed(true), workSource },
          ),
        ),
      );
    }),
  );

  it.effect("hands an exhausted recovery to a human with a handoff note", () =>
    Effect.gen(function* () {
      const exhausted: ObservedItem = {
        ...claimedByUs,
        attempts: [
          { stage: "implement", outcome: "failed", atMillis: 1 },
          { stage: "implement", outcome: "failed", atMillis: 2 },
        ],
      };
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const roles = yield* Ref.make<ReadonlyArray<string>>([]);
      const workSource: Partial<WorkSourceService> = {
        observe: () => Effect.succeed([exhausted]),
        release: () => Effect.void,
        note: (_workspace, _itemId, detail) => Ref.update(notes, (xs) => [...xs, detail]),
        setRoles: (_workspace, _itemId, changes) => Ref.update(roles, (xs) => [...xs, ...changes.add]),
      };
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.recover();
        const note = (yield* Ref.get(notes))[0] ?? "";
        assert.include(note, "Exhausted after 3 failed implement attempts");
        assert.include(note, recoveryReason);
        assert.deepStrictEqual(yield* Ref.get(roles), ["ready-for-human"]);
      }).pipe(
        Effect.provide(
          schedulerLayer(
            { globalLimit: 4, dailyBudget: 100 },
            { registry: [wsA], snapshot: snapshotOf([]), execute: () => Effect.succeed(true), workSource },
          ),
        ),
      );
    }),
  );
});
