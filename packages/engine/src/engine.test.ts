import { DaemonRpcs, WorkItemId, WorkspaceId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Daemon from "./daemon";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunEventBus from "./run-event-bus";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import type { ObservedItem } from "./work-source";
import * as WorkSource from "./work-source";
import { WorktreeManager } from "./worktree";

const validModule: Registry.LoadedWorkspace = {
  source: "example.workspace.ts",
  value: {
    name: "example",
    checkoutPath: "/repos/example",
    workSource: { type: "linear" },
    harness: { preferred: "cursor" },
  },
};

const malformedModule: Registry.LoadedWorkspace = {
  source: "broken.workspace.ts",
  value: { name: "missing required fields" },
};

const sampleResult: Registry.LoadResult = {
  loaded: [validModule, malformedModule],
  failures: [{ source: "unreadable.workspace.ts", message: "boom" }],
};

const id = Schema.decodeSync(WorkItemId);

const stub = (service: Partial<WorkSource.WorkSourceService>): WorkSource.WorkSourceService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  claim: () => Effect.void,
  release: () => Effect.void,
  recordAttempt: () => Effect.void,
  recordFollowUp: () => Effect.void,
  note: () => Effect.void,
  setRoles: () => Effect.void,
  ...service,
});

const observing = (items: ReadonlyArray<ObservedItem>) =>
  Layer.succeed(WorkSource.WorkSource, stub({ observe: () => Effect.succeed(items) }));

describe("buildRegistry", () => {
  it("registers valid configs and isolates malformed and unreadable ones", () => {
    const state = Registry.buildRegistry(sampleResult);
    assert.strictEqual(state.workspaces.length, 1);
    assert.strictEqual(state.workspaces[0]?.config.name, "example");
    assert.strictEqual(state.failures.length, 2);
    assert.deepStrictEqual(state.failures.map((f) => f.source).sort(), [
      "broken.workspace.ts",
      "unreadable.workspace.ts",
    ]);
  });

  it("isolates a second file that reuses a registered workspace name", () => {
    const duplicate: Registry.LoadedWorkspace = {
      source: "example-copy.workspace.ts",
      value: validModule.value,
    };
    const state = Registry.buildRegistry({ loaded: [validModule, duplicate], failures: [] });
    assert.strictEqual(state.workspaces.length, 1);
    assert.strictEqual(state.failures.length, 1);
    assert.strictEqual(state.failures[0]?.source, "example-copy.workspace.ts");
  });
});

describe("decide", () => {
  const registered = Registry.buildRegistry({ loaded: [validModule], failures: [] });

  it("emits a registration event for a valid, unseen config", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "register-workspace",
      source: validModule.source,
      module: validModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registered");
  });

  it("rejects a config whose name is already registered", () => {
    const events = Registry.decide(registered, {
      type: "register-workspace",
      source: "example-dup.workspace.ts",
      module: validModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registration-failed");
  });

  it("turns a decode failure into a registration-failed event", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "register-workspace",
      source: malformedModule.source,
      module: malformedModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registration-failed");
  });

  it("passes an import failure straight through as a registration-failed event", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "record-import-failure",
      source: "unreadable.workspace.ts",
      message: "boom",
    });
    assert.deepStrictEqual(events, [
      { type: "workspace.registration-failed", source: "unreadable.workspace.ts", message: "boom" },
    ]);
  });
});

describe("reconcile worker", () => {
  const registryLayer = Layer.succeed(Registry.WorkspaceRegistry, Registry.buildRegistry(sampleResult));

  const workerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, WorkSource.emptyLayer)),
  );

  it.effect("emits a receipt reflecting the registry when a reconcile is submitted", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.workspaces, 1);
      assert.strictEqual(receipt.failures, 2);
      assert.strictEqual(receipt.pendingWork, 0);
      assert.strictEqual(receipt.paused, 0);
    }).pipe(Effect.provide(workerLayer), Effect.scoped),
  );

  const eligibleItem: ObservedItem = {
    id: id("AUD-1"),
    title: "first ticket",
    roles: ["ready-for-agent"],
    claimLabeled: false,
    claim: null,
    attempts: [],
    pr: null,
    openBlockers: 0,
  };
  const workerWithWork = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, observing([eligibleItem]))),
  );

  it.effect("advances the snapshot generation on every published reconcile", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      assert.strictEqual((yield* worker.snapshot).generation, 0);
      yield* worker.submit();
      assert.strictEqual((yield* worker.snapshot).generation, 1);
      yield* worker.submit();
      assert.strictEqual((yield* worker.snapshot).generation, 2);
    }).pipe(Effect.provide(workerLayer), Effect.scoped),
  );

  it.effect("classifies observed work into the eligible set per workspace", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.pendingWork, 1);
      assert.strictEqual(receipt.paused, 0);
      const snapshot = yield* worker.snapshot;
      assert.strictEqual(snapshot.workspaces[0]?.eligible[0]?.stage, "implement");
    }).pipe(Effect.provide(workerWithWork), Effect.scoped),
  );

  const inReviewItem: ObservedItem = {
    id: id("AUD-2"),
    title: "pr under review",
    roles: [],
    claimLabeled: false,
    claim: null,
    attempts: [],
    pr: {
      review: "pending",
      checks: "passing",
      latestHumanCommentAtMillis: null,
      fresh: false,
      baseDivergence: "none",
      followUp: null,
    },
    openBlockers: 0,
  };
  const workerWithInReview = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, observing([inReviewItem]))),
  );

  it.effect("retains a non-actionable but open ticket in the observed set", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const state = (yield* worker.snapshot).workspaces[0];
      assert.strictEqual(state?.eligible.length, 0);
      assert.strictEqual(state?.claimed.length, 0);
      assert.strictEqual(state?.needsHuman.length, 0);
      assert.deepStrictEqual(
        state?.observed.map((item) => item.id),
        [id("AUD-2")],
      );
    }).pipe(Effect.provide(workerWithInReview), Effect.scoped),
  );

  const authFailingSource = Layer.succeed(
    WorkSource.WorkSource,
    stub({
      observe: () =>
        Effect.fail(
          new WorkSource.WorkSourceError({
            reason: "auth",
            message: "GitHub authentication failed (401)",
          }),
        ),
    }),
  );
  const workerWithAuthFailure = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, authFailingSource)),
  );

  it.effect("pauses a workspace on auth failure instead of failing the tick", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.paused, 1);
      assert.strictEqual(receipt.pendingWork, 0);
      const state = (yield* worker.snapshot).workspaces[0];
      assert.strictEqual(state?.poll.status, "paused");
      assert.deepStrictEqual(
        state?.poll.status === "paused"
          ? { reason: state.poll.reason, retryAtMillis: state.poll.retryAtMillis }
          : null,
        { reason: "auth", retryAtMillis: null },
      );
    }).pipe(Effect.provide(workerWithAuthFailure), Effect.scoped),
  );

  const rateLimitedSource = (observes: Ref.Ref<number>, retryAfterMillis: number | undefined) =>
    Layer.succeed(
      WorkSource.WorkSource,
      stub({
        rateLimitScope: () => "linear:LINEAR_API_KEY",
        observe: () =>
          Effect.flatMap(
            Ref.update(observes, (count) => count + 1),
            () =>
              Effect.fail(
                new WorkSource.WorkSourceError({
                  reason: "rate-limited",
                  message: "Linear rate limit exceeded",
                  retryAfterMillis,
                }),
              ),
          ),
      }),
    );

  const rateLimitedWorker = (observes: Ref.Ref<number>, retryAfterMillis?: number) =>
    Reconcile.layer.pipe(
      Layer.provide(Layer.mergeAll(registryLayer, rateLimitedSource(observes, retryAfterMillis))),
    );

  it.effect("skips polling a rate-limited credential until its window elapses", () =>
    Effect.gen(function* () {
      const observes = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 1);

        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 1);
        const paused = (yield* worker.snapshot).workspaces[0]?.poll;
        assert.strictEqual(paused?.status === "paused" ? paused.reason : null, "rate-limited");
        assert.isNotNull(paused?.status === "paused" ? paused.retryAtMillis : null);

        yield* TestClock.adjust("31 seconds");
        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 2);
      }).pipe(Effect.provide(rateLimitedWorker(observes, 30_000)), Effect.scoped);
    }),
  );

  it.effect("warns once on entering a backoff window rather than on every skipped tick", () =>
    Effect.gen(function* () {
      const observes = yield* Ref.make(0);
      const logged: Array<string> = [];
      yield* Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        yield* worker.submit();
        yield* worker.submit();
        yield* worker.submit();
      }).pipe(
        Effect.provide(rateLimitedWorker(observes, 30_000)),
        Effect.scoped,
        Effect.withLogger(Logger.make(({ message }) => void logged.push(String(message)))),
      );
      const warnings = logged.filter((line) => line.includes("work source rate limited; backing off"));
      assert.strictEqual(warnings.length, 1);
    }),
  );

  it.effect("falls back to exponential backoff when the source reports no retry timing", () =>
    Effect.gen(function* () {
      const observes = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        yield* worker.submit();
        yield* TestClock.adjust("59 seconds");
        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 1);
        yield* TestClock.adjust("2 seconds");
        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 2);
      }).pipe(Effect.provide(rateLimitedWorker(observes)), Effect.scoped);
    }),
  );

  const scopelessSource = (observes: Ref.Ref<number>) =>
    Layer.succeed(
      WorkSource.WorkSource,
      stub({
        observe: () =>
          Effect.flatMap(
            Ref.update(observes, (count) => count + 1),
            () =>
              Effect.fail(
                new WorkSource.WorkSourceError({ reason: "rate-limited", message: "secondary rate limit" }),
              ),
          ),
      }),
    );

  it.effect("keeps polling a source that reports no rate-limit scope, and invents no retry time", () =>
    Effect.gen(function* () {
      const observes = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        yield* worker.submit();
        yield* worker.submit();
        assert.strictEqual(yield* Ref.get(observes), 2);
        const paused = (yield* worker.snapshot).workspaces[0]?.poll;
        assert.deepStrictEqual(
          paused?.status === "paused" ? { reason: paused.reason, retryAtMillis: paused.retryAtMillis } : null,
          { reason: "rate-limited", retryAtMillis: null },
        );
      }).pipe(
        Effect.provide(
          Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, scopelessSource(observes)))),
        ),
        Effect.scoped,
      );
    }),
  );
});

const registeredSample = Layer.succeed(Registry.WorkspaceRegistry, Registry.buildRegistry(sampleResult));

const schedulerStubService = {
  tick: () => Effect.succeed([]),
  drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
  recover: () => Effect.void,
  config: { globalLimit: 4, dailyBudget: 50 },
  stats: Effect.succeed({
    ...Scheduler.initialState,
    global: 3,
    perWorkspace: new Map([[Schema.decodeSync(WorkspaceId)("example"), 2]]),
    budgetDay: 0,
    budgetUsed: 7,
  }),
} satisfies Scheduler.Scheduler["Service"];

describe("daemon heartbeats", () => {
  const worktreeStub = Layer.succeed(WorktreeManager, {
    ensure: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    remove: () => Effect.void,
    reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
  });

  it.effect("drains the scheduler when a stop signal interrupts them", () =>
    Effect.gen(function* () {
      const drained = yield* Ref.make<ReadonlyArray<number>>([]);
      const schedulerStub = Layer.succeed(Scheduler.Scheduler, {
        ...schedulerStubService,
        drain: (options) =>
          Ref.update(drained, (graces) => [...graces, options.graceMillis]).pipe(
            Effect.map(() => ({ inFlight: 0, interrupted: 0 })),
          ),
      });
      yield* Effect.gen(function* () {
        const beats = yield* Effect.forkChild(
          Daemon.heartbeats({
            pollIntervalMillis: 60_000,
            drain: { graceMillis: 1234, abort: Latch.makeUnsafe(false).await },
          }),
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.interrupt(beats);

        assert.deepStrictEqual(yield* Ref.get(drained), [1234]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registeredSample, WorkSource.emptyLayer))),
            registeredSample,
            schedulerStub,
            worktreeStub,
          ),
        ),
        Effect.scoped,
      );
    }),
  );
});

describe("daemon status over rpc", () => {
  const registryLayer = registeredSample;
  const schedulerStub = Layer.succeed(Scheduler.Scheduler, schedulerStubService);
  const daemonLayer = (sourceLayer: Layer.Layer<WorkSource.WorkSource>) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, sourceLayer)))),
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(schedulerStub),
      Layer.provideMerge(RunLedger.layerMemory),
      Layer.provideMerge(RunEventBus.layer),
    );

  const layer = daemonLayer(WorkSource.emptyLayer);

  it.effect("reports health, registered workspaces, their derived work, and failures", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(status.health, "running");
      assert.strictEqual(status.workspaces.length, 1);
      assert.strictEqual(status.workspaces[0]?.name, "example");
      assert.strictEqual(status.workspaces[0]?.workSource, "linear");
      assert.strictEqual(status.workspaces[0]?.poll.status, "ok");
      assert.deepStrictEqual(status.workspaces[0]?.eligible, []);
      assert.strictEqual(status.failures.length, 2);
      assert.isAtLeast(status.uptimeMillis, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  const needsInfoItem: ObservedItem = {
    id: id("AUD-7"),
    title: "waiting on details",
    roles: ["needs-info"],
    claimLabeled: false,
    claim: null,
    attempts: [],
    pr: null,
    openBlockers: 0,
  };

  it.effect("carries needs-human items and their reason across the status boundary", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.deepStrictEqual(status.workspaces[0]?.needsHuman, [
        { id: id("AUD-7"), title: "waiting on details", reason: "needs-info" },
      ]);
    }).pipe(Effect.provide(daemonLayer(observing([needsInfoItem]))), Effect.scoped),
  );

  const blockedItem: ObservedItem = {
    id: id("AUD-8"),
    title: "waiting on a dependency",
    roles: ["ready-for-agent"],
    claimLabeled: false,
    claim: null,
    attempts: [],
    pr: null,
    openBlockers: 2,
  };

  it.effect("carries blocked items and their open-blocker count across the status boundary", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(receipt.pendingWork, 0);
      assert.deepStrictEqual(status.workspaces[0]?.eligible, []);
      assert.deepStrictEqual(status.workspaces[0]?.blocked, [
        { id: id("AUD-8"), title: "waiting on a dependency", openBlockers: 2 },
      ]);
    }).pipe(Effect.provide(daemonLayer(observing([blockedItem]))), Effect.scoped),
  );

  it.effect("surfaces scheduler caps and budget in the status payload", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(status.scheduler.globalInFlight, 3);
      assert.strictEqual(status.scheduler.globalLimit, 4);
      assert.strictEqual(status.scheduler.dailyBudgetUsed, 7);
      assert.strictEqual(status.scheduler.dailyBudgetLimit, 50);
      assert.strictEqual(status.scheduler.perWorkspace.length, 1);
      assert.strictEqual(status.scheduler.perWorkspace[0]?.name, "example");
      assert.strictEqual(status.scheduler.perWorkspace[0]?.inFlight, 2);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
