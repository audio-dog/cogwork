import {
  DaemonRpcs,
  HarnessName,
  IssueTrackerError,
  RunId,
  type RunRecord,
  type TriageRole,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import type { HandOffOutcome, ReclassifyOutcome, TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import * as Scheduler from "./scheduler";
import { type PrSignals, SourceControlProvider } from "./source-control";

const id = Schema.decodeSync(WorkItemId);
const rid = Schema.decodeSync(RunId);
const wsid = Schema.decodeSync(WorkspaceId);
const harness = Schema.decodeSync(HarnessName);

const registered: Registry.LoadedWorkspace = {
  source: "example.workspace.ts",
  value: {
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
    harness: { preferred: "cursor" },
  },
};

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.buildRegistry({ loaded: [registered], failures: [] }),
);

const schedulerStub = (setScheduling?: Scheduler.Scheduler["Service"]["setScheduling"]) =>
  Layer.succeed(Scheduler.Scheduler, {
    tick: () => Effect.succeed([]),
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: () => Effect.void,
    setScheduling: setScheduling ?? (() => Effect.succeed(Scheduler.initialState)),
    config: { globalLimit: 4, dailyBudget: 50 },
    stats: Effect.succeed(Scheduler.initialState),
  });

interface TrackerCalls {
  readonly reclassify: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: ReclassifyOutcome }>;
  readonly handOff: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: HandOffOutcome }>;
  readonly released: ReadonlyArray<WorkItemId>;
}

const emptyCalls: TrackerCalls = { reclassify: [], handOff: [], released: [] };

const providerStub = Layer.succeed(SourceControlProvider, {
  observe: () => Effect.succeed(new Map<WorkItemId, PrSignals>()),
  comment: () => Effect.void,
});

const trackerLayer = (
  service: Partial<IssueTracker.IssueTrackerService>,
): Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider> =>
  Layer.mergeAll(
    Layer.succeed(IssueTracker.IssueTracker, {
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
    }),
    providerStub,
  );

const recordingTracker = (items: ReadonlyArray<TrackerItem>, calls: Ref.Ref<TrackerCalls>) =>
  trackerLayer({
    observe: () => Effect.succeed(items),
    reclassify: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, reclassify: [...c.reclassify, { workItem, outcome }] })),
    handOff: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, handOff: [...c.handOff, { workItem, outcome }] })),
    release: (_workspace, workItem) =>
      Ref.update(calls, (c) => ({ ...c, released: [...c.released, workItem] })),
  });

const runLedgerLayer = RunLedger.layerMemory.pipe(Layer.provideMerge(DaemonEventBus.layer));
const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedgerLayer));

const daemonLayer = (
  source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>,
  scheduler = schedulerStub(),
) =>
  Daemon.handlersLayer.pipe(
    Layer.provideMerge(Daemon.principalMiddlewareLayer),
    Layer.provideMerge(Daemon.daemonInfoLayer),
    Layer.provideMerge(Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, source)))),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(scheduler),
    Layer.provideMerge(runRecorder),
    Layer.provideMerge(runLedgerLayer),
    Layer.provideMerge(RunControl.layer),
    Layer.provideMerge(source),
  );

const runRecord = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: rid("run-1"),
  workspace: wsid("example"),
  workItem: id("AUD-1"),
  stage: "implement",
  harness: harness("cursor"),
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 0,
  endedAtMillis: null,
  ...over,
});

const trackerItem = (over: Partial<TrackerItem> = {}): TrackerItem => ({
  id: id("AUD-1"),
  title: "cancel me",
  url: "https://linear.app/acme/issue/AUD-1",
  roles: ["ready-for-agent"],
  assignees: [],
  claimLabeled: true,
  claim: null,
  claimedByUs: true,
  attempts: [],
  owned: false,
  followUp: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  ...over,
});

describe("CancelRun", () => {
  it.effect("settles the run, hands the item off to a human, and releases the claim", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const item = yield* client.CancelRun({ runId: rid("run-1"), note: "stopping this one" });

      assert.strictEqual(item._tag, "NeedsHuman");
      if (item._tag === "NeedsHuman") {
        assert.strictEqual(item.reason, "ready-for-human");
        assert.strictEqual(item.url, "https://linear.app/acme/issue/AUD-1");
      }

      const settled = yield* ledger.getRun(rid("run-1"));
      assert.strictEqual(settled?.status, "interrupted");

      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: "stopping this one" } },
      ]);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((event) => event._tag === "ItemChanged"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?.item._tag, "NeedsHuman");
    }).pipe(Effect.provide(daemonLayer(recordingTracker([trackerItem()], calls))), Effect.scoped);
  });

  it.effect("fails with RunNotFound for an unknown run", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("ghost") }));
      assert.strictEqual(error._tag, "RunNotFound");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("fails with RunAlreadyFinished for a run that is not running", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord({ status: "succeeded", endedAtMillis: 10 }));
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("run-1") }));
      assert.strictEqual(error._tag, "RunAlreadyFinished");
      if (error._tag === "RunAlreadyFinished") assert.strictEqual(error.status, "succeeded");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );
});

describe("Reclassify", () => {
  it.effect("moves an item to a new role, notes it, and returns the reprojected item", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const item = trackerItem({
      id: id("AUD-2"),
      roles: ["needs-triage"],
      claimedByUs: false,
      claimLabeled: false,
    });
    return Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.Reclassify({
        workspace: wsid("example"),
        workItem: id("AUD-2"),
        role: "ready-for-agent" as TriageRole,
        note: "picking this up",
      });

      assert.strictEqual(result?._tag, "Eligible");
      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.reclassify, [
        {
          workItem: id("AUD-2"),
          outcome: {
            changes: { remove: ["needs-triage"], add: ["ready-for-agent"] },
            note: "picking this up",
          },
        },
      ]);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?._tag, "ItemChanged");
      if (published?._tag === "ItemChanged") assert.strictEqual(published.item._tag, "Eligible");
    }).pipe(Effect.provide(daemonLayer(recordingTracker([item], calls))), Effect.scoped);
  });

  it.effect("returns null when the item is reclassified as wontfix", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.Reclassify({
        workspace: wsid("example"),
        workItem: id("AUD-3"),
        role: "wontfix" as TriageRole,
      });
      assert.strictEqual(result, null);
    }).pipe(
      Effect.provide(
        daemonLayer(trackerLayer({ observe: () => Effect.succeed([trackerItem({ id: id("AUD-3") })]) })),
      ),
      Effect.scoped,
    ),
  );

  it.effect("fails with WorkItemNotFound for an unknown item", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(
        client.Reclassify({
          workspace: wsid("example"),
          workItem: id("MISSING"),
          role: "ready-for-agent" as TriageRole,
        }),
      );
      assert.strictEqual(error._tag, "WorkItemNotFound");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("surfaces an issue tracker failure", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(
        client.Reclassify({
          workspace: wsid("example"),
          workItem: id("AUD-4"),
          role: "ready-for-agent" as TriageRole,
        }),
      );
      assert.strictEqual(error._tag, "IssueTrackerError");
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({
            observe: () => Effect.succeed([trackerItem({ id: id("AUD-4") })]),
            reclassify: () =>
              Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "tracker down" })),
          }),
        ),
      ),
      Effect.scoped,
    ),
  );
});

describe("RunControl", () => {
  it.effect("interrupts a registered fiber on cancel and reports unknown runs", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const fiber = yield* Effect.forkChild(Effect.never);
      yield* control.register(rid("run-1"), fiber);

      const cancelled = yield* control.cancel(rid("run-1"));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(cancelled);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));

      assert.isFalse(yield* control.cancel(rid("run-1")));
      assert.isFalse(yield* control.cancel(rid("ghost")));
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );
});

describe("SetScheduling", () => {
  const pausableScheduler = () => {
    const setScheduling: Scheduler.Scheduler["Service"]["setScheduling"] = (desired) =>
      Effect.succeed({ ...Scheduler.initialState, paused: desired === "paused" });
    return schedulerStub(setScheduling);
  };

  it.effect("reports paused after pausing and running after resuming", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const paused = yield* client.SetScheduling({ desired: "paused" });
      assert.strictEqual(paused.scheduling, "paused");
      const running = yield* client.SetScheduling({ desired: "running" });
      assert.strictEqual(running.scheduling, "running");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}), pausableScheduler())), Effect.scoped),
  );
});
