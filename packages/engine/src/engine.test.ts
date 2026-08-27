import { DaemonRpcs, WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ControlStore } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import * as EventPublisher from "./event-publisher";
import type { TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
import * as Reconcile from "./reconcile";
import * as Recovery from "./recovery";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import * as Scheduler from "./scheduler";
import { type PrSignals, SourceControlProvider } from "./source-control";
import { WorktreeManager } from "./worktree";

const workspaceId = Schema.decodeSync(WorkspaceId);

const registeredWorkspace: Registry.RegisteredWorkspace = {
  source: "control-store:example",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
    harness: { preferred: "cursor" },
  }),
};

const sampleRegistry: Registry.RegistryState = {
  workspaces: [registeredWorkspace],
  failures: [
    {
      name: workspaceId("broken"),
      source: "control-store:broken",
      message: "invalid Workspace input",
    },
    { source: "control-store:unreadable", message: "cannot read Workspace input" },
  ],
};

const id = Schema.decodeSync(WorkItemId);

const stub = (service: Partial<IssueTracker.IssueTrackerService>): IssueTracker.IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  claim: () => Effect.void,
  release: () => Effect.void,
  note: () => Effect.void,
  triaged: () => Effect.void,
  implemented: () => Effect.void,
  followedUp: () => Effect.void,
  attemptFailed: () => Effect.void,
  handOff: () => Effect.void,
  stalled: () => Effect.void,
  reclassify: () => Effect.void,
  ...service,
});

const providerStub = (prs: ReadonlyArray<readonly [WorkItemId, PrSignals]> = []) =>
  Layer.succeed(SourceControlProvider, {
    observe: () => Effect.succeed(new Map(prs)),
    comment: () => Effect.void,
  });

const sources = <R = never>(
  issueTrackerLayer: Layer.Layer<IssueTracker.IssueTracker, never, R>,
  prs: ReadonlyArray<readonly [WorkItemId, PrSignals]> = [],
) => Layer.mergeAll(issueTrackerLayer, providerStub(prs));

const observing = (
  items: ReadonlyArray<TrackerItem>,
  prs: ReadonlyArray<readonly [WorkItemId, PrSignals]> = [],
) => sources(Layer.succeed(IssueTracker.IssueTracker, stub({ observe: () => Effect.succeed(items) })), prs);

class ReconcileObserveCount extends Context.Service<ReconcileObserveCount, Ref.Ref<number>>()(
  "@cogwork/engine/engine.test/ReconcileObserveCount",
) {
  static readonly layer = Layer.effect(ReconcileObserveCount, Ref.make(0));
}

class LogMessages extends Context.Service<LogMessages, MutableRef.MutableRef<ReadonlyArray<string>>>()(
  "@cogwork/engine/engine.test/LogMessages",
) {
  static readonly layer = Layer.sync(LogMessages, () => MutableRef.make<ReadonlyArray<string>>([]));
  static readonly captureLayer = Logger.layer([
    Effect.map(LogMessages, (messages) =>
      Logger.make(({ message }) => MutableRef.update(messages, (current) => [...current, String(message)])),
    ),
  ]).pipe(Layer.provideMerge(LogMessages.layer));
}

const defectOnceThenObserve = sources(
  Layer.effect(
    IssueTracker.IssueTracker,
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      return stub({
        observe: Effect.fn(function* () {
          const count = yield* Ref.getAndUpdate(observes, (current) => current + 1);
          if (count === 0) return yield* Effect.die("reconcile defect");
          return [];
        }),
      });
    }),
  ),
);

describe("reconcile worker", () => {
  const registryLayer = Layer.succeed(Registry.WorkspaceRegistry, Registry.readOnlyRegistry(sampleRegistry));

  const workerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, sources(IssueTracker.emptyLayer))),
  );
  const defectiveWorkerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, defectOnceThenObserve)),
    Layer.provideMerge(ReconcileObserveCount.layer),
    Layer.provideMerge(LogMessages.captureLayer),
  );
  const neverWorkerLayer = Reconcile.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer,
        sources(Layer.succeed(IssueTracker.IssueTracker, stub({ observe: () => Effect.never }))),
      ),
    ),
    Layer.provideMerge(LogMessages.captureLayer),
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

  it.effect("settles a defective reconcile and continues with the next submission", () =>
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      const messages = yield* LogMessages;
      const worker = yield* Reconcile.ReconcileWorker;
      const firstFiber = yield* Effect.forkChild(
        worker.submit().pipe(Effect.timeout("1 second"), Effect.sandbox, Effect.flip),
      );
      yield* TestClock.adjust("1 second");
      const first = yield* Fiber.join(firstFiber);
      assert.include(Cause.pretty(first), "reconcile defect");

      const second = yield* worker.submit();
      assert.strictEqual(second.workspaces, 1);
      assert.strictEqual(yield* Ref.get(observes), 2);
      assert.isTrue(MutableRef.get(messages).some((line) => line.includes("reconcile job failed")));
    }).pipe(Effect.provide(defectiveWorkerLayer), Effect.scoped),
  );

  it.effect("logs and fails a submission whose receipt does not settle", () =>
    Effect.gen(function* () {
      const messages = yield* LogMessages;
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(Reconcile.ReconcileWorker, (worker) =>
          worker.submit().pipe(Effect.timeout("31 seconds"), Effect.flip),
        ),
      );
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(fiber);
      assert.isTrue(Cause.isTimeoutError(error));
      assert.isTrue(MutableRef.get(messages).some((line) => line.includes("reconcile submission timed out")));
    }).pipe(Effect.provide(neverWorkerLayer), Effect.scoped),
  );

  it.effect("coalesces submissions while a timed-out reconcile is still running", () =>
    Effect.gen(function* () {
      const release = yield* Latch.make();
      const secondStarted = yield* Deferred.make<void>();
      const observes = yield* Ref.make(0);
      const source = sources(
        Layer.succeed(
          IssueTracker.IssueTracker,
          stub({
            observe: Effect.fn(function* () {
              const count = yield* Ref.getAndUpdate(observes, (current) => current + 1);
              if (count > 0) yield* Deferred.succeed(secondStarted, undefined);
              yield* release.await;
              return [];
            }),
          }),
        ),
      );
      const layer = Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, source)));

      yield* Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        const submissions = yield* Effect.forkChild(
          Effect.all([worker.submit(), worker.submit()], { concurrency: "unbounded" }).pipe(Effect.exit),
        );
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(submissions);

        const duplicate = yield* Effect.forkChild(
          Deferred.await(secondStarted).pipe(Effect.timeout("1 second"), Effect.flip),
        );
        yield* release.open;
        yield* TestClock.adjust("1 second");
        const error = yield* Fiber.join(duplicate);

        assert.isTrue(Cause.isTimeoutError(error));
        assert.strictEqual(yield* Ref.get(observes), 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  const eligibleItem: TrackerItem = {
    id: id("AUD-1"),
    title: "first ticket",
    url: "https://linear.app/acme/issue/AUD-1",
    priority: "medium",
    roles: ["ready-for-agent"],
    assignees: [],
    claimLabeled: false,
    claim: null,
    claimedByUs: false,
    attempts: [],
    owned: false,
    followUp: null,
    openBlockers: 0,
    proposal: null,
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

  const inReviewItem: TrackerItem = {
    id: id("AUD-2"),
    title: "pr under review",
    url: "https://linear.app/acme/issue/AUD-2",
    priority: "medium",
    roles: [],
    assignees: [],
    claimLabeled: false,
    claim: null,
    claimedByUs: false,
    attempts: [],
    owned: true,
    followUp: null,
    openBlockers: 0,
    proposal: null,
  };
  const inReviewPr: PrSignals = {
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    review: "pending",
    checks: "passing",
    latestHumanCommentAtMillis: null,
    latestBotTriggerAtMillis: null,
    fresh: false,
    baseDivergence: "none",
    waitingSinceMillis: 1_700_000_000_000,
    headRef: "aud-2-in-review",
    followable: true,
  };
  const workerWithInReview = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, observing([inReviewItem], [[id("AUD-2"), inReviewPr]]))),
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

  const authFailingSource = sources(
    Layer.succeed(
      IssueTracker.IssueTracker,
      stub({
        observe: () =>
          Effect.fail(
            new IssueTracker.IssueTrackerError({
              reason: "auth",
              message: "GitHub authentication failed (401)",
            }),
          ),
      }),
    ),
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
    sources(
      Layer.succeed(
        IssueTracker.IssueTracker,
        stub({
          rateLimitScope: () => "linear:LINEAR_API_KEY",
          observe: () =>
            Effect.flatMap(
              Ref.update(observes, (count) => count + 1),
              () =>
                Effect.fail(
                  new IssueTracker.IssueTrackerError({
                    reason: "rate-limited",
                    message: "Linear rate limit exceeded",
                    retryAfterMillis,
                  }),
                ),
            ),
        }),
      ),
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
    sources(
      Layer.succeed(
        IssueTracker.IssueTracker,
        stub({
          observe: () =>
            Effect.flatMap(
              Ref.update(observes, (count) => count + 1),
              () =>
                Effect.fail(
                  new IssueTracker.IssueTrackerError({
                    reason: "rate-limited",
                    message: "secondary rate limit",
                  }),
                ),
            ),
        }),
      ),
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

const registeredSample = Layer.succeed(Registry.WorkspaceRegistry, Registry.readOnlyRegistry(sampleRegistry));

const schedulerStubService = {
  tick: () => Effect.succeed(0),
  awaitIdle: Effect.void,
  drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
  admit: () => Effect.void,
  setScheduling: () => Effect.succeed(Scheduler.initialState),
  setConfig: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
  config: Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
  stats: Effect.succeed({
    ...Scheduler.initialState,
    global: 3,
    perWorkspace: new Map([
      [workspaceId("example"), 2],
      [workspaceId("broken"), 1],
    ]),
    budgetDay: 0,
    budgetUsed: 7,
  }),
} satisfies Scheduler.Scheduler["Service"];

class SchedulerTickCount extends Context.Service<SchedulerTickCount, Ref.Ref<number>>()(
  "@cogwork/engine/engine.test/SchedulerTickCount",
) {
  static readonly layer = Layer.effect(SchedulerTickCount, Ref.make(0));
  static readonly schedulerLayer = Layer.effect(
    Scheduler.Scheduler,
    Effect.gen(function* () {
      const ticks = yield* SchedulerTickCount;
      return {
        ...schedulerStubService,
        tick: () => Ref.update(ticks, (count) => count + 1).pipe(Effect.map(() => 0)),
      };
    }),
  ).pipe(Layer.provideMerge(SchedulerTickCount.layer));
}

class SchedulerDrainGraces extends Context.Service<SchedulerDrainGraces, Ref.Ref<ReadonlyArray<number>>>()(
  "@cogwork/engine/engine.test/SchedulerDrainGraces",
) {
  static readonly layer = Layer.effect(SchedulerDrainGraces, Ref.make<ReadonlyArray<number>>([]));
  static readonly schedulerLayer = Layer.effect(
    Scheduler.Scheduler,
    Effect.gen(function* () {
      const drained = yield* SchedulerDrainGraces;
      return {
        ...schedulerStubService,
        drain: (options: Scheduler.DrainOptions) =>
          Ref.update(drained, (graces) => [...graces, options.graceMillis]).pipe(
            Effect.map(() => ({ inFlight: 0, interrupted: 0 })),
          ),
      };
    }),
  ).pipe(Layer.provideMerge(SchedulerDrainGraces.layer));
}

class BootstrapRecoveryCalls extends Context.Service<BootstrapRecoveryCalls, Ref.Ref<number>>()(
  "@cogwork/engine/engine.test/BootstrapRecoveryCalls",
) {
  static readonly layer = Layer.effect(BootstrapRecoveryCalls, Ref.make(0));
  static readonly recoveryLayer = Layer.effect(
    Recovery.Recovery,
    Effect.map(BootstrapRecoveryCalls, (calls) => ({
      recover: () => Effect.void,
      recoverWhenLive: () => Ref.update(calls, (count) => count + 1),
    })),
  ).pipe(Layer.provideMerge(BootstrapRecoveryCalls.layer));
}

describe("daemon heartbeats", () => {
  const worktreeStub = Layer.succeed(WorktreeManager, {
    ensure: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    remove: () => Effect.void,
    reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
  });
  const emptyWorkerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registeredSample, sources(IssueTracker.emptyLayer))),
  );
  const defectiveWorkerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registeredSample, defectOnceThenObserve)),
    Layer.provideMerge(ReconcileObserveCount.layer),
  );
  const heartbeatLayer = <WorkerServices, SchedulerServices>(
    workerLayer: Layer.Layer<Reconcile.ReconcileWorker | WorkerServices>,
    schedulerLayer: Layer.Layer<Scheduler.Scheduler | SchedulerServices>,
  ) =>
    EventPublisher.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          workerLayer,
          registeredSample,
          schedulerLayer,
          Layer.succeed(ControlStore, { health: "available" }),
          worktreeStub,
          DaemonEventBus.layer,
          Layer.succeed(Recovery.Recovery, {
            recover: () => Effect.void,
            recoverWhenLive: () => Effect.void,
          }),
        ),
      ),
    );

  it.effect("drains the scheduler when a stop signal interrupts them", () =>
    Effect.gen(function* () {
      const drained = yield* SchedulerDrainGraces;
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
      Effect.provide(heartbeatLayer(emptyWorkerLayer, SchedulerDrainGraces.schedulerLayer)),
      Effect.scoped,
    ),
  );

  it.effect("continues bootstrap after the initial reconcile submission fails", () =>
    Effect.gen(function* () {
      const recoveryCalls = yield* BootstrapRecoveryCalls;
      yield* Daemon.bootstrap;
      assert.strictEqual(yield* Ref.get(recoveryCalls), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          defectiveWorkerLayer,
          BootstrapRecoveryCalls.recoveryLayer,
          Layer.succeed(ControlStore, { health: "available" }),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("publishes state after a reconcile submission fails", () =>
    Effect.gen(function* () {
      const publishes = yield* Ref.make(0);
      const publisherLayer = Layer.succeed(EventPublisher.DaemonEventPublisher, {
        publishItems: () => Ref.update(publishes, (count) => count + 1),
        publishWorkspaces: () => Effect.void,
        publishScheduler: () =>
          Effect.succeed({
            scheduling: "running",
            globalInFlight: 0,
            globalLimit: 4,
            perWorkspaceLimit: 4,
            dailyBudgetUsed: 0,
            dailyBudgetLimit: 50,
            perWorkspace: [],
          }),
      });
      const layer = publisherLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            defectiveWorkerLayer,
            registeredSample,
            SchedulerTickCount.schedulerLayer,
            Layer.succeed(ControlStore, { health: "available" }),
            worktreeStub,
            DaemonEventBus.layer,
            Layer.succeed(Recovery.Recovery, {
              recover: () => Effect.void,
              recoverWhenLive: () => Effect.void,
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const beats = yield* Effect.forkChild(
          Daemon.heartbeats({
            pollIntervalMillis: 60_000,
            drain: { graceMillis: 1234, abort: Latch.makeUnsafe(false).await },
          }),
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.interrupt(beats);

        assert.strictEqual(yield* Ref.get(publishes), 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("keeps both heartbeats running after a reconcile submission fails", () =>
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      const schedulerTicks = yield* SchedulerTickCount;
      const beats = yield* Effect.forkChild(
        Daemon.heartbeats({
          pollIntervalMillis: 1_000,
          drain: { graceMillis: 1234, abort: Latch.makeUnsafe(false).await },
        }),
      );
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.interrupt(beats);

      assert.isAtLeast(yield* Ref.get(observes), 2);
      assert.isAtLeast(yield* Ref.get(schedulerTicks), 2);
    }).pipe(
      Effect.provide(heartbeatLayer(defectiveWorkerLayer, SchedulerTickCount.schedulerLayer)),
      Effect.scoped,
    ),
  );
});

describe("daemon status over rpc", () => {
  const registryLayer = registeredSample;
  const schedulerStub = Layer.succeed(Scheduler.Scheduler, schedulerStubService);
  const runLedger = RunLedger.layerMemory.pipe(Layer.provideMerge(DaemonEventBus.layer));
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger));
  const daemonLayer = (sourceLayer: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(EventPublisher.layer),
      Layer.provideMerge(Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, sourceLayer)))),
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(Registry.managementReadOnlyLayer),
      Layer.provideMerge(schedulerStub),
      Layer.provideMerge(Layer.succeed(ControlStore, { health: "available" })),
      Layer.provideMerge(runRecorder),
      Layer.provideMerge(runLedger),
      Layer.provideMerge(RunControl.layer),
      Layer.provideMerge(sourceLayer),
    );

  const layer = daemonLayer(sources(IssueTracker.emptyLayer));

  it.effect("reports health, registered workspaces, their derived work, and failures", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(status.health, "running");
      assert.strictEqual(status.workspaces.length, 1);
      assert.strictEqual(status.workspaces[0]?.name, "example");
      assert.strictEqual(status.workspaces[0]?.issueTracker, "linear");
      assert.strictEqual(status.workspaces[0]?.poll.status, "pending");
      assert.deepStrictEqual(status.workspaces[0]?.eligible, []);
      assert.strictEqual(status.failures.length, 2);
      assert.strictEqual(status.failures[0]?.name, "broken");
      assert.isAtLeast(status.uptimeMillis, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("reports a workspace poll as ok only once it has actually polled", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      assert.strictEqual((yield* client.GetStatus()).workspaces[0]?.poll.status, "pending");
      yield* (yield* Reconcile.ReconcileWorker).submit();
      assert.strictEqual((yield* client.GetStatus()).workspaces[0]?.poll.status, "ok");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  const needsInfoItem: TrackerItem = {
    id: id("AUD-7"),
    title: "waiting on details",
    url: "https://linear.app/acme/issue/AUD-7",
    priority: "medium",
    roles: ["needs-info"],
    assignees: [],
    claimLabeled: false,
    claim: null,
    claimedByUs: false,
    attempts: [],
    owned: false,
    followUp: null,
    openBlockers: 0,
    proposal: "Which auth provider should this target — Clerk or Auth0?",
  };

  it.effect(
    "carries needs-human items, their reason, and the triage proposal across the status boundary",
    () =>
      Effect.gen(function* () {
        const worker = yield* Reconcile.ReconcileWorker;
        yield* worker.submit();
        const client = yield* RpcTest.makeClient(DaemonRpcs);
        const status = yield* client.GetStatus();
        assert.deepStrictEqual(status.workspaces[0]?.needsHuman, [
          {
            id: id("AUD-7"),
            title: "waiting on details",
            reason: "needs-info",
            proposal: "Which auth provider should this target — Clerk or Auth0?",
            url: "https://linear.app/acme/issue/AUD-7",
          },
        ]);
      }).pipe(Effect.provide(daemonLayer(observing([needsInfoItem]))), Effect.scoped),
  );

  const blockedItem: TrackerItem = {
    id: id("AUD-8"),
    title: "waiting on a dependency",
    url: "https://linear.app/acme/issue/AUD-8",
    priority: "medium",
    roles: ["ready-for-agent"],
    assignees: [],
    claimLabeled: false,
    claim: null,
    claimedByUs: false,
    attempts: [],
    owned: false,
    followUp: null,
    openBlockers: 2,
    proposal: null,
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
        {
          id: id("AUD-8"),
          title: "waiting on a dependency",
          url: "https://linear.app/acme/issue/AUD-8",
          openBlockers: 2,
        },
      ]);
    }).pipe(Effect.provide(daemonLayer(observing([blockedItem]))), Effect.scoped),
  );

  const inReviewOwnedItem: TrackerItem = {
    id: id("AUD-9"),
    title: "pr in review",
    url: "https://linear.app/acme/issue/AUD-9",
    priority: "medium",
    roles: ["ready-for-agent"],
    assignees: [],
    claimLabeled: false,
    claim: null,
    claimedByUs: false,
    attempts: [],
    owned: true,
    followUp: null,
    openBlockers: 0,
    proposal: null,
  };
  const readyPr: PrSignals = {
    number: 77,
    url: "https://github.com/owner/repo/pull/77",
    review: "ready",
    checks: "passing",
    latestHumanCommentAtMillis: null,
    latestBotTriggerAtMillis: null,
    fresh: false,
    baseDivergence: "none",
    waitingSinceMillis: 1_786_000_000_000,
    headRef: "aud-9-pr-in-review",
    followable: true,
  };

  it.effect("carries a PR summary on every classified item that has a linked pull request", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      const eligible = status.workspaces[0]?.eligible[0];
      assert.strictEqual(eligible?.stage, "verify");
      assert.deepStrictEqual(eligible?.pr, {
        number: 77,
        url: "https://github.com/owner/repo/pull/77",
        checks: "passing",
        review: "ready",
        baseDivergence: "none",
        waitingSinceMillis: 1_786_000_000_000,
      });
    }).pipe(
      Effect.provide(daemonLayer(observing([inReviewOwnedItem], [[id("AUD-9"), readyPr]]))),
      Effect.scoped,
    ),
  );

  it.effect("leaves an item without a pull request free of a PR summary", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      const blocked = status.workspaces[0]?.blocked[0];
      assert.deepStrictEqual(blocked, {
        id: id("AUD-8"),
        title: "waiting on a dependency",
        url: "https://linear.app/acme/issue/AUD-8",
        openBlockers: 2,
      });
      assert.notProperty(blocked, "pr");
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
      assert.deepStrictEqual(status.scheduler.perWorkspace, [
        { name: workspaceId("example"), inFlight: 2, limit: 4 },
        { name: workspaceId("broken"), inFlight: 1, limit: 4 },
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
