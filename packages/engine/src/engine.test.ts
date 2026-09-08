import {
  Connection,
  type ConnectionId,
  type ConnectionReadiness,
  connectionIdOf,
  DaemonEvent,
  DaemonRpcs,
  defaultControlStore,
  PollState,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceRegistrationError,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ConnectionStore, connectionOverview } from "./connection";
import { ControlStore } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import * as EventPublisher from "./event-publisher";
import type { TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
import { observeWorkspace } from "./observe";
import { PluginManager } from "./plugin";
import * as Reconcile from "./reconcile";
import * as Recovery from "./recovery";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as Scheduler from "./scheduler";
import { type PrSignals, SourceControlProvider } from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import { harnessProbeTestLayer } from "./testing/harness-probe-layer";
import { WorktreeManager } from "./worktree";

const workspaceId = Schema.decodeSync(WorkspaceId);
const interruptionGate = Latch.makeUnsafe();
const pluginManagerLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed([]),
});
const reconcileLayer = Reconcile.layer.pipe(
  Layer.provide(DaemonEventBus.layer),
  Layer.provide(pluginManagerLayer),
);

const registeredWorkspace: Registry.RegisteredWorkspace = {
  source: "control-store:example",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
  }),
  workspaceLimit: 1001,
};

const sampleRegistry: Registry.RegistryState = {
  workspaces: [registeredWorkspace],
  failures: [
    {
      name: workspaceId("broken"),
      displayName: "Broken workspace",
      source: "control-store:broken",
      message: "invalid Workspace input",
    },
    { source: "control-store:unreadable", message: "cannot read Workspace input" },
  ],
};

const id = Schema.decodeSync(WorkItemId);

const rateLimitHits = Metric.counter("cogwork_reconcile_rate_limit_hits_total", {
  description: "Rate-limit responses observed while polling issue trackers.",
});

const stub = (service: Partial<IssueTracker.IssueTrackerService>): IssueTracker.IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  createIssue: () => Effect.void,
  claim: () => Effect.void,
  release: () => Effect.void,
  note: () => Effect.void,
  triaged: () => Effect.void,
  implemented: () => Effect.void,
  followedUp: () => Effect.void,
  attemptFailed: () => Effect.void,
  handOff: () => Effect.void,
  handBack: () => Effect.void,
  stalled: () => Effect.void,
  reclassify: () => Effect.void,
  ...service,
});

const providerStub = (prs: ReadonlyArray<readonly [WorkItemId, PrSignals]> = []) =>
  Layer.succeed(SourceControlProvider, {
    observe: () => Effect.succeed(new Map(prs)),
    comment: () => Effect.void,
    findOpenPullRequest: () => Effect.succeed(null),
    openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
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

interface ReconcileCoordinationProbeService {
  readonly observes: Ref.Ref<number>;
  readonly firstStarted: Latch.Latch;
  readonly secondStarted: Deferred.Deferred<void>;
  readonly release: Latch.Latch;
}

class ReconcileCoordinationProbe extends Context.Service<
  ReconcileCoordinationProbe,
  ReconcileCoordinationProbeService
>()("@cogwork/engine/engine.test/ReconcileCoordinationProbe") {
  static readonly layer = Layer.effect(
    ReconcileCoordinationProbe,
    Effect.gen(function* () {
      return {
        observes: yield* Ref.make(0),
        firstStarted: yield* Latch.make(),
        secondStarted: yield* Deferred.make<void>(),
        release: yield* Latch.make(),
      };
    }),
  );
}

class ConnectionRevocations extends Context.Service<
  ConnectionRevocations,
  Ref.Ref<ReadonlyArray<ConnectionId>>
>()("@cogwork/engine/engine.test/ConnectionRevocations") {
  static readonly layer = Layer.effect(ConnectionRevocations, Ref.make<ReadonlyArray<ConnectionId>>([]));
}

class PublishedItemCount extends Context.Service<PublishedItemCount, Ref.Ref<number>>()(
  "@cogwork/engine/engine.test/PublishedItemCount",
) {
  static readonly layer = Layer.effect(PublishedItemCount, Ref.make(0));
}

describe("workspace observation", () => {
  const workspace: Registry.RegisteredWorkspace = {
    ...registeredWorkspace,
    config: Schema.decodeSync(WorkspaceConfig)({
      name: "example",
      checkoutPath: "/repos/example",
      issueTracker: {
        type: "linear",
        connectionId: "linear/acme",
        teams: ["ENG"],
      },
      sourceControl: {
        type: "github",
        connectionId: "github/acme",
        repo: "acme/example",
      },
    }),
  };
  const githubWorkspace: Registry.RegisteredWorkspace = {
    ...workspace,
    config: Schema.decodeSync(WorkspaceConfig)({
      name: "github-example",
      checkoutPath: "/repos/github-example",
      issueTracker: {
        type: "github",
        connectionId: "github/acme",
        repo: "acme/example",
      },
    }),
  };
  const auth = new IssueTracker.IssueTrackerError({ reason: "auth", message: "unauthorized" });

  it.effect("identifies the tracker Connection when tracker observation fails", () =>
    Effect.gen(function* () {
      const observe = observeWorkspace(stub({ observe: () => Effect.fail(auth) }), {
        observe: () => Effect.succeed(new Map()),
        comment: () => Effect.void,
        findOpenPullRequest: () => Effect.succeed(null),
        openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
      });
      const error = yield* Effect.flip(observe(workspace));

      assert.strictEqual(error.connectionId, workspace.config.issueTracker.connectionId);
    }),
  );

  it.effect("identifies the source-control Connection when provider observation fails", () =>
    Effect.gen(function* () {
      const observe = observeWorkspace(stub({}), {
        observe: () => Effect.fail(auth),
        comment: () => Effect.void,
        findOpenPullRequest: () => Effect.succeed(null),
        openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
      });
      const error = yield* Effect.flip(observe(workspace));

      assert.strictEqual(error.connectionId, workspace.config.sourceControl?.connectionId);
    }),
  );

  it.effect("uses the GitHub tracker Connection for fallback source-control failures", () =>
    Effect.gen(function* () {
      const observe = observeWorkspace(stub({}), {
        observe: () => Effect.fail(auth),
        comment: () => Effect.void,
        findOpenPullRequest: () => Effect.succeed(null),
        openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
      });
      const error = yield* Effect.flip(observe(githubWorkspace));

      assert.strictEqual(error.connectionId, githubWorkspace.config.issueTracker.connectionId);
    }),
  );
});

const defectOnceThenObserve = sources(
  Layer.effect(
    IssueTracker.IssueTracker,
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      return stub({
        observe: Effect.fn("test.observe")(function* () {
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

  const workerLayer = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, sources(IssueTracker.emptyLayer))),
  );
  const defectiveWorkerLayer = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, defectOnceThenObserve)),
    Layer.provideMerge(ReconcileObserveCount.layer),
    Layer.provideMerge(LogMessages.captureLayer),
  );
  const neverWorkerLayer = () =>
    reconcileLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          sources(
            Layer.succeed(
              IssueTracker.IssueTracker,
              stub({
                observe: () =>
                  interruptionGate.await.pipe(Effect.flatMap(() => Effect.die("interruption gate opened"))),
              }),
            ),
          ),
        ),
      ),
      Layer.provideMerge(LogMessages.captureLayer),
    );
  const coordinatedSource = (
    observe: (probe: ReconcileCoordinationProbeService) => IssueTracker.IssueTrackerService["observe"],
  ) =>
    sources(
      Layer.effect(
        IssueTracker.IssueTracker,
        Effect.map(ReconcileCoordinationProbe, (probe) => stub({ observe: observe(probe) })),
      ),
    );
  const coalescingSource = coordinatedSource((probe) =>
    Effect.fn("test.coalescingSource")(function* () {
      const count = yield* Ref.getAndUpdate(probe.observes, (current) => current + 1);
      if (count > 0) yield* Deferred.succeed(probe.secondStarted, undefined);
      yield* probe.release.await;
      return [];
    }),
  );
  const postCurrentSource = coordinatedSource((probe) =>
    Effect.fn("test.postCurrentSource")(function* () {
      const count = yield* Ref.getAndUpdate(probe.observes, (current) => current + 1);
      if (count > 0) return [];
      yield* probe.firstStarted.open;
      yield* probe.release.await;
      return [];
    }),
  );
  const coordinatedWorkerLayer = (
    source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider, never, ReconcileCoordinationProbe>,
  ) =>
    reconcileLayer.pipe(
      Layer.provide(Layer.mergeAll(registryLayer, source)),
      Layer.provideMerge(ReconcileCoordinationProbe.layer),
    );

  it.effect("emits a receipt reflecting the registry when a reconcile is submitted", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const before = (yield* Metric.value(Reconcile.reconcilePollDuration)).count;
      const receipt = yield* worker.submit();
      assert.strictEqual((yield* Metric.value(Reconcile.reconcilePollDuration)).count, before + 1);
      assert.strictEqual(receipt.workspaces, 1);
      assert.strictEqual(receipt.failures, 2);
      assert.strictEqual(receipt.pendingWork, 0);
      assert.strictEqual(receipt.paused, 0);
    }).pipe(Effect.provide(workerLayer), Effect.scoped),
  );

  it.effect("keeps a registry refresh failure typed", () => {
    const failure = new WorkspaceRegistrationError({ message: "registry refresh failed" });
    const failedRegistry = Layer.succeed(Registry.WorkspaceRegistry, {
      ...Registry.readOnlyRegistry(sampleRegistry),
      refresh: Effect.fail(failure),
    });
    const layer = reconcileLayer.pipe(
      Layer.provide(Layer.mergeAll(failedRegistry, sources(IssueTracker.emptyLayer))),
    );

    return Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      assert.strictEqual(yield* Effect.flip(worker.submit()), failure);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("settles a pending receipt when the worker scope drains", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const drainingRegistry = Layer.succeed(Registry.WorkspaceRegistry, {
        ...Registry.readOnlyRegistry(sampleRegistry),
        refresh: Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(
            interruptionGate.await.pipe(Effect.flatMap(() => Effect.die("interruption gate opened"))),
          ),
        ),
      });
      const workerScope = yield* Scope.make();
      const context = yield* reconcileLayer.pipe(
        Layer.provide(Layer.mergeAll(drainingRegistry, sources(IssueTracker.emptyLayer))),
        Layer.buildWithScope(workerScope),
      );
      const worker = Context.get(context, Reconcile.ReconcileWorker);
      const submitting = yield* Effect.forkChild(worker.submit().pipe(Effect.exit));

      yield* Deferred.await(refreshStarted);
      yield* Scope.close(workerScope, Exit.void);
      const joining = yield* Effect.forkChild(
        Fiber.join(submitting).pipe(Effect.timeout("1 second"), Effect.exit),
      );
      yield* TestClock.adjust("1 second");
      const joined = yield* Fiber.join(joining);
      if (Exit.isFailure(joined)) return assert.fail("receipt did not settle during drain");
      const settled = joined.value;
      if (Exit.isSuccess(settled)) return assert.fail("expected an interrupted receipt");
      assert.isTrue(Cause.hasInterruptsOnly(settled.cause));
    }),
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
    }).pipe(Effect.provide(neverWorkerLayer()), Effect.scoped),
  );

  it.effect("coalesces submissions while a timed-out reconcile is still running", () =>
    Effect.gen(function* () {
      const probe = yield* ReconcileCoordinationProbe;
      const worker = yield* Reconcile.ReconcileWorker;
      const submissions = yield* Effect.forkChild(
        Effect.all([worker.submit(), worker.submit()], { concurrency: "unbounded" }).pipe(Effect.exit),
      );
      yield* TestClock.adjust("31 seconds");
      yield* Fiber.join(submissions);

      const duplicate = yield* Effect.forkChild(
        Deferred.await(probe.secondStarted).pipe(Effect.timeout("1 second"), Effect.flip),
      );
      yield* probe.release.open;
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(duplicate);

      assert.isTrue(Cause.isTimeoutError(error));
      assert.strictEqual(yield* Ref.get(probe.observes), 1);
    }).pipe(Effect.provide(coordinatedWorkerLayer(coalescingSource)), Effect.scoped),
  );

  it.effect("runs a post-current submission after an in-flight reconcile", () =>
    Effect.gen(function* () {
      const probe = yield* ReconcileCoordinationProbe;
      const worker = yield* Reconcile.ReconcileWorker;
      const current = yield* Effect.forkChild(worker.submit());
      yield* probe.firstStarted.await;
      const next = yield* Effect.forkChild(worker.submitAfterCurrent());
      yield* probe.release.open;
      yield* Fiber.join(current);
      yield* Fiber.join(next);

      assert.strictEqual(yield* Ref.get(probe.observes), 2);
    }).pipe(Effect.provide(coordinatedWorkerLayer(postCurrentSource)), Effect.scoped),
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
    handback: null,
    followUp: null,
    openBlockers: 0,
    proposal: null,
  };
  const workerWithWork = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, observing([eligibleItem]))),
  );
  const manyEligibleItems = Array.from({ length: 101 }, (_, index) => ({
    ...eligibleItem,
    id: id(`AUD-${index + 1}`),
    title: `ticket ${index + 1}`,
  }));
  const workerWithManyItems = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, observing(manyEligibleItems))),
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

  it.effect("classifies and counts more than one page of observed work", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      const state = (yield* worker.snapshot).workspaces[0];

      assert.strictEqual(receipt.pendingWork, 101);
      assert.strictEqual(state?.eligible.length, 101);
      assert.strictEqual(state?.observedCount, 101);
    }).pipe(Effect.provide(workerWithManyItems), Effect.scoped),
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
    handback: null,
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
    draft: false,
  };
  const workerWithInReview = reconcileLayer.pipe(
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
  const workerWithAuthFailure = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, authFailingSource)),
  );
  const connectedGithubWorkspace: Registry.RegisteredWorkspace = {
    ...registeredWorkspace,
    config: Schema.decodeSync(WorkspaceConfig)({
      name: "example",
      checkoutPath: "/repos/example",
      issueTracker: {
        type: "github",
        connectionId: "github/acme",
        repo: "acme/example",
      },
    }),
  };
  const connectedRegistry = Layer.succeed(
    Registry.WorkspaceRegistry,
    Registry.readOnlyRegistry({ workspaces: [connectedGithubWorkspace], failures: [] }),
  );
  const revokingConnectionStore = Layer.effect(
    ConnectionStore,
    Effect.map(ConnectionRevocations, (revoked) => ({
      overview: Ref.get(revoked).pipe(
        Effect.map((connections) => {
          const isRevoked = connections.length > 0;
          const connection = Connection.make({
            id: connectionIdOf("github", "acme"),
            system: "github",
            account: "acme",
            status: isRevoked ? "revoked" : "established",
          });
          const readiness = isRevoked
            ? ({ _tag: "NotReady", reason: "Connection needs re-connect" } satisfies ConnectionReadiness)
            : ({ _tag: "Ready" } satisfies ConnectionReadiness);
          return connectionOverview([connection], new Map([[connection.id, readiness]]));
        }),
      ),
      find: () => Effect.succeed(null),
      findSystem: () => Effect.succeed(null),
      bearer: () => Effect.die("unexpected Connection bearer"),
      readiness: () => Effect.succeed({ _tag: "Ready" } satisfies ConnectionReadiness),
      requireReady: () => Effect.void,
      requireSystemReady: () => Effect.void,
      establish: () => Effect.die("unexpected Connection establish"),
      revoke: (connectionId) => Ref.update(revoked, (connections) => [...connections, connectionId]),
      remove: () => Effect.die("unexpected Connection remove"),
    })),
  );
  const workerWithConnectionRevocation = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(connectedRegistry, authFailingSource, revokingConnectionStore)),
    Layer.provideMerge(ConnectionRevocations.layer),
  );
  const workerWithConnectionEvents = Reconcile.layer.pipe(
    Layer.provideMerge(DaemonEventBus.layer),
    Layer.provide(pluginManagerLayer),
    Layer.provide(Layer.mergeAll(connectedRegistry, authFailingSource, revokingConnectionStore)),
    Layer.provideMerge(ConnectionRevocations.layer),
  );

  it.effect("pauses a workspace on auth failure instead of failing the tick", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.paused, 1);
      assert.strictEqual(receipt.pendingWork, 0);
      const state = (yield* worker.snapshot).workspaces[0];
      if (!state || !PollState.guards.paused(state.poll)) return assert.fail("expected paused poll");
      assert.deepStrictEqual(
        { reason: state.poll.reason, retryAtMillis: state.poll.retryAtMillis },
        { reason: "auth", retryAtMillis: null },
      );
    }).pipe(Effect.provide(workerWithAuthFailure), Effect.scoped),
  );

  it.effect("revokes the configured Connection when an auth failure omits its identity", () =>
    Effect.gen(function* () {
      const revoked = yield* ConnectionRevocations;
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      assert.deepStrictEqual(yield* Ref.get(revoked), [connectionIdOf("github", "acme")]);
    }).pipe(Effect.provide(workerWithConnectionRevocation), Effect.scoped),
  );

  it.effect("publishes revoked Connection readiness after an auth failure", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const published = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ConnectionsChanged),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* (yield* Reconcile.ReconcileWorker).submit();
      const events = yield* Fiber.join(published);

      const event = events[0];
      if (!event || !DaemonEvent.guards.ConnectionsChanged(event)) {
        return assert.fail("expected ConnectionsChanged");
      }
      const github = event.connections.connections.find((connection) => connection.system === "github");
      assert.strictEqual(github?.connection?.status, "revoked");
      assert.strictEqual(github?.readiness._tag, "NotReady");
    }).pipe(Effect.provide(workerWithConnectionEvents), Effect.scoped),
  );

  const rateLimitedSource = (retryAfterMillis: number | undefined) =>
    sources(
      Layer.effect(
        IssueTracker.IssueTracker,
        Effect.map(ReconcileObserveCount, (observes) =>
          stub({
            rateLimitScope: () => "linear:LINEAR_API_KEY",
            observe: () =>
              Ref.update(observes, (count) => count + 1).pipe(
                Effect.andThen(
                  Effect.fail(
                    new IssueTracker.IssueTrackerError({
                      reason: "rate-limited",
                      message: "Linear rate limit exceeded",
                      retryAfterMillis,
                    }),
                  ),
                ),
              ),
          }),
        ),
      ),
    );

  const rateLimitedWorker = (retryAfterMillis?: number) =>
    reconcileLayer.pipe(
      Layer.provide(Layer.mergeAll(registryLayer, rateLimitedSource(retryAfterMillis))),
      Layer.provideMerge(ReconcileObserveCount.layer),
    );

  const loggedRateLimitedWorker = rateLimitedWorker(30_000).pipe(
    Layer.provideMerge(LogMessages.captureLayer),
  );

  it.effect("skips polling a rate-limited credential until its window elapses", () =>
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 1);

      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 1);
      const paused = (yield* worker.snapshot).workspaces[0]?.poll;
      if (!paused || !PollState.guards.paused(paused)) return assert.fail("expected paused poll");
      assert.strictEqual(paused.reason, "rate-limited");
      assert.isNotNull(paused.retryAtMillis);

      yield* TestClock.adjust("31 seconds");
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 2);
    }).pipe(Effect.provide(rateLimitedWorker(30_000)), Effect.scoped),
  );

  it.effect("warns once on entering a backoff window rather than on every skipped tick", () =>
    Effect.gen(function* () {
      const messages = yield* LogMessages;
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      yield* worker.submit();
      yield* worker.submit();
      const warnings = MutableRef.get(messages).filter((line) =>
        line.includes("work source rate limited; backing off"),
      );
      assert.strictEqual(warnings.length, 1);
    }).pipe(Effect.provide(loggedRateLimitedWorker), Effect.scoped),
  );

  it.effect("counts every shared-scope rate-limit hit while warning once with workspace correlation", () =>
    Effect.gen(function* () {
      const observes = yield* Ref.make(0);
      const observationGate = yield* Latch.make();
      const otherWorkspace: Registry.RegisteredWorkspace = {
        ...registeredWorkspace,
        config: { ...registeredWorkspace.config, name: workspaceId("other") },
      };
      const registry = Layer.succeed(
        Registry.WorkspaceRegistry,
        Registry.readOnlyRegistry({ workspaces: [registeredWorkspace, otherWorkspace], failures: [] }),
      );
      const source = sources(
        Layer.succeed(
          IssueTracker.IssueTracker,
          stub({
            rateLimitScope: () => "linear:LINEAR_API_KEY",
            observe: Effect.fn("test.rateLimitedObserve")(function* () {
              const count = yield* Ref.updateAndGet(observes, (current) => current + 1);
              if (count === 2) yield* observationGate.open;
              yield* observationGate.await;
              return yield* new IssueTracker.IssueTrackerError({
                reason: "rate-limited",
                message: "Linear rate limit exceeded",
                retryAfterMillis: 30_000,
              });
            }),
          }),
        ),
      );
      const layer = reconcileLayer.pipe(Layer.provide(Layer.mergeAll(registry, source)));
      const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = [];
      const hitMetric = Metric.withAttributes(rateLimitHits, { scope: "linear:LINEAR_API_KEY" });
      const hitsBefore = (yield* Metric.value(hitMetric)).count;

      yield* Reconcile.ReconcileWorker.pipe(
        Effect.flatMap((worker) => worker.submit()),
        Effect.provide(layer),
        Effect.scoped,
        Effect.withLogger(
          Logger.make(({ fiber, message }) =>
            logs.push({
              message,
              annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
            }),
          ),
        ),
      );

      assert.strictEqual(yield* Ref.get(observes), 2);
      assert.strictEqual((yield* Metric.value(hitMetric)).count, hitsBefore + 2);
      const warnings = logs.filter(({ message }) =>
        Array.isArray(message)
          ? message.includes("work source rate limited; backing off")
          : message === "work source rate limited; backing off",
      );
      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(Object.keys(warnings[0]?.annotations ?? {}), ["workspace"]);
      assert.isTrue(["example", "other"].includes(String(warnings[0]?.annotations.workspace)));
      assert.deepStrictEqual(warnings[0]?.message, [
        "work source rate limited; backing off",
        {
          scope: "linear:LINEAR_API_KEY",
          message: "Linear rate limit exceeded",
          retryAtMillis: 30_000,
        },
      ]);
    }),
  );

  it.effect("falls back to exponential backoff when the source reports no retry timing", () =>
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      yield* TestClock.adjust("59 seconds");
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 1);
      yield* TestClock.adjust("2 seconds");
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 2);
      yield* TestClock.adjust("119 seconds");
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 2);
      yield* TestClock.adjust("2 seconds");
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 3);
    }).pipe(Effect.provide(rateLimitedWorker()), Effect.scoped),
  );

  const scopelessSource = sources(
    Layer.effect(
      IssueTracker.IssueTracker,
      Effect.map(ReconcileObserveCount, (observes) =>
        stub({
          observe: () =>
            Ref.update(observes, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new IssueTracker.IssueTrackerError({
                    reason: "rate-limited",
                    message: "secondary rate limit",
                  }),
                ),
              ),
            ),
        }),
      ),
    ),
  );

  const scopelessWorker = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, scopelessSource)),
    Layer.provideMerge(ReconcileObserveCount.layer),
  );

  it.effect("keeps polling a source that reports no rate-limit scope, and invents no retry time", () =>
    Effect.gen(function* () {
      const observes = yield* ReconcileObserveCount;
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      yield* worker.submit();
      assert.strictEqual(yield* Ref.get(observes), 2);
      const paused = (yield* worker.snapshot).workspaces[0]?.poll;
      if (!paused || !PollState.guards.paused(paused)) return assert.fail("expected paused poll");
      assert.deepStrictEqual(
        { reason: paused.reason, retryAtMillis: paused.retryAtMillis },
        { reason: "rate-limited", retryAtMillis: null },
      );
    }).pipe(Effect.provide(scopelessWorker), Effect.scoped),
  );
});

const registeredSample = Layer.succeed(Registry.WorkspaceRegistry, Registry.readOnlyRegistry(sampleRegistry));

const availableControlStore = Layer.succeed(ControlStore, {
  health: "available",
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  setDaemonLimit: () => Effect.succeed(defaultControlStore),
  establishConnection: () => Effect.succeed(defaultControlStore),
  revokeConnection: () => Effect.succeed(defaultControlStore),
  removeConnection: () => Effect.succeed(defaultControlStore),
  setHarnessEnabled: () => Effect.succeed(defaultControlStore),
  updateOperationSetting: () => Effect.succeed(defaultControlStore),
  installPlugin: () => Effect.succeed(defaultControlStore),
  uninstallPlugin: () => Effect.succeed(defaultControlStore),
  updateContributionSetting: () => Effect.succeed(defaultControlStore),
  withWrite: (effect) => effect,
});
const schedulerStubService = {
  tick: () => Effect.succeed(0),
  awaitIdle: Effect.void,
  drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
  admit: () => Effect.void,
  isInFlight: () => Effect.succeed(false),
  setScheduling: () => Effect.succeed(Scheduler.initialState),
  setLimit: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
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
    pullRequestReadiness: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    remove: () => Effect.void,
    reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
  });
  const emptyWorkerLayer = reconcileLayer.pipe(
    Layer.provide(Layer.mergeAll(registeredSample, sources(IssueTracker.emptyLayer))),
  );
  const defectiveWorkerLayer = reconcileLayer.pipe(
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
          availableControlStore,
          worktreeStub,
          DaemonEventBus.layer,
          Layer.succeed(Recovery.Recovery, {
            recover: () => Effect.void,
            recoverWhenLive: () => Effect.void,
          }),
        ),
      ),
    );
  const countingPublisherLayer = Layer.effect(
    EventPublisher.DaemonEventPublisher,
    Effect.map(PublishedItemCount, (publishes) => ({
      publishItems: () => Ref.update(publishes, (count) => count + 1),
      publishWorkspaces: () => Effect.succeed([]),
      publishWorkspaceRemoved: Effect.succeed,
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
      publishControlStore: (controlStore) => Effect.succeed(controlStore),
      publishPlugins: (plugins) => Effect.succeed(plugins),
      publishConnections: (connections) => Effect.succeed(connections),
    })),
  );
  const publishingHeartbeatLayer = countingPublisherLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        defectiveWorkerLayer,
        registeredSample,
        SchedulerTickCount.schedulerLayer,
        availableControlStore,
        worktreeStub,
        DaemonEventBus.layer,
        Layer.succeed(Recovery.Recovery, {
          recover: () => Effect.void,
          recoverWhenLive: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(PublishedItemCount.layer),
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
        Layer.mergeAll(defectiveWorkerLayer, BootstrapRecoveryCalls.recoveryLayer, availableControlStore),
      ),
      Effect.scoped,
    ),
  );

  it.effect("publishes state after a reconcile submission fails", () =>
    Effect.gen(function* () {
      const publishes = yield* PublishedItemCount;
      const beats = yield* Effect.forkChild(
        Daemon.heartbeats({
          pollIntervalMillis: 60_000,
          drain: { graceMillis: 1234, abort: Latch.makeUnsafe(false).await },
        }),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(beats);

      assert.strictEqual(yield* Ref.get(publishes), 1);
    }).pipe(Effect.provide(publishingHeartbeatLayer), Effect.scoped),
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
  const engineServices = engineTestLayer();
  const daemonLayer = (sourceLayer: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(harnessProbeTestLayer()),
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(EventPublisher.layer),
      Layer.provideMerge(reconcileLayer.pipe(Layer.provide(Layer.mergeAll(registryLayer, sourceLayer)))),
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(Registry.managementReadOnlyLayer),
      Layer.provideMerge(schedulerStub),
      Layer.provideMerge(availableControlStore),
      Layer.provideMerge(pluginManagerLayer),
      Layer.provideMerge(engineServices),
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
      const [workspace] = status.workspaces;
      assert.isTrue(workspace !== undefined && PollState.guards.pending(workspace.poll));
      assert.deepStrictEqual(status.workspaces[0]?.eligible, []);
      assert.strictEqual(status.failures.length, 2);
      assert.strictEqual(status.failures[0]?.name, "broken");
      assert.strictEqual(status.failures[0]?.displayName, "Broken workspace");
      assert.isAtLeast(status.uptimeMillis, 0);
      assert.strictEqual(status.eventBusDroppedEvents, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("reports daemon event bus loss", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      yield* bus.subscribe();
      yield* Effect.forEach(
        Array.from({ length: 1025 }, (_, i) => i),
        (i) =>
          bus.publish({
            _tag: "SchedulerChanged",
            scheduler: {
              scheduling: "running",
              globalInFlight: i,
              globalLimit: 4,
              perWorkspaceLimit: 4,
              dailyBudgetUsed: 7,
              dailyBudgetLimit: 50,
              perWorkspace: [],
            },
          }),
        { discard: true },
      );

      assert.strictEqual((yield* client.GetStatus()).eventBusDroppedEvents, 1);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("accepts desktop health samples and dumps live metrics", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      yield* client.ReportProcessHealth({
        samples: [
          {
            process: "renderer",
            sampledAtMillis: 1_000,
            heapUsedBytes: 400,
            heapLimitBytes: 1_000,
            protocolInboxDepth: 3,
            eventsAppliedPerSecond: 12,
          },
        ],
      });
      const metrics = yield* client.GetMetrics();
      assert.include(metrics, "cogwork_process_heap_headroom_bytes");
      assert.include(metrics, "cogwork_renderer_protocol_inbox_depth");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("reports a workspace poll as ok only once it has actually polled", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const [pending] = (yield* client.GetStatus()).workspaces;
      assert.isTrue(pending !== undefined && PollState.guards.pending(pending.poll));
      yield* (yield* Reconcile.ReconcileWorker).submit();
      const [ok] = (yield* client.GetStatus()).workspaces;
      assert.isTrue(ok !== undefined && PollState.guards.ok(ok.poll));
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
    handback: null,
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
    handback: null,
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

  const inReviewItem: TrackerItem = {
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
    handback: null,
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
    draft: false,
  };

  it.effect("carries a required PR summary on a ready-to-merge item", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.deepStrictEqual(status.workspaces[0]?.readyToMerge, [
        {
          id: id("AUD-9"),
          title: "pr in review",
          url: "https://linear.app/acme/issue/AUD-9",
          pr: {
            number: 77,
            url: "https://github.com/owner/repo/pull/77",
            checks: "passing",
            review: "ready",
            baseDivergence: "none",
            waitingSinceMillis: 1_786_000_000_000,
          },
        },
      ]);
    }).pipe(Effect.provide(daemonLayer(observing([inReviewItem], [[id("AUD-9"), readyPr]]))), Effect.scoped),
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
        { name: workspaceId("example"), inFlight: 2, limit: 1001 },
        { name: workspaceId("broken"), inFlight: 1, limit: 4 },
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
