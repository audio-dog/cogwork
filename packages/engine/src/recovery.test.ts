import {
  type AttemptRecord,
  DaemonEvent,
  HarnessName,
  type OperationAvailability,
  type PollState,
  RunId,
  type RunRecord,
  SessionId,
  WorkItemId,
  type WorkItemId as WorkItemIdType,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { EligibleWork } from "./classify";
import { recoveryReason } from "./comments";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import type { ObservedItem } from "./issue-tracker";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import * as Reconcile from "./reconcile";
import * as Recovery from "./recovery";
import * as Registry from "./registry";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";

const id = Schema.decodeSync(WorkItemId);
const rid = Schema.decodeSync(RunId);
const session = Schema.decodeSync(SessionId)("sess-abc");

const crashLoopsCapped = Metric.counter("cogwork_recovery_crash_loops_capped_total", {
  description: "Recovery crash loops capped before another resume.",
});

const wsA: RegisteredWorkspace = {
  source: "a.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "a",
    checkoutPath: "/repos/a",
    issueTracker: { type: "github", repo: "owner/a", actorLogin: "cogwork-bot" },
  }),
};

const interruptedRun: RunRecord = {
  id: Schema.decodeSync(RunId)("run-1"),
  workspace: wsA.config.name,
  workItem: id("#1"),
  stage: "implement",
  harness: Schema.decodeSync(HarnessName)("cursor"),
  branch: "1-ours",
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 1,
  endedAtMillis: null,
};

const interrupted: RunRecord = { ...interruptedRun, status: "interrupted", endedAtMillis: 2 };

const crashedRun = (idStr: string, startedAtMillis: number, status: RunRecord["status"]): RunRecord => ({
  ...interruptedRun,
  id: Schema.decodeSync(RunId)(idStr),
  status,
  startedAtMillis,
  endedAtMillis: status === "running" ? null : startedAtMillis + 1,
});

const claimedByUs: ObservedItem = {
  id: id("#1"),
  title: "ours",
  url: "https://github.com/owner/repo/issues/1",
  roles: ["ready-for-agent"],
  assignees: [],
  claimLabeled: true,
  claim: { by: "cogwork-bot", claimedAtMillis: 1, stage: "implement" },
  claimedByUs: true,
  attempts: [],
  handback: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  pr: null,
};

const claimedByOther: ObservedItem = {
  id: id("#2"),
  title: "theirs",
  url: "https://github.com/owner/repo/issues/2",
  roles: [],
  assignees: [],
  claimLabeled: true,
  claim: { by: "someone-else", claimedAtMillis: 1 },
  claimedByUs: false,
  attempts: [],
  handback: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  pr: null,
};

const unclaimed: ObservedItem = {
  id: id("#3"),
  title: "free",
  url: "https://github.com/owner/repo/issues/3",
  roles: ["needs-triage"],
  assignees: [],
  claimLabeled: false,
  claim: null,
  claimedByUs: false,
  attempts: [],
  handback: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  pr: null,
};

const staleNoStage: ObservedItem = {
  id: id("#4"),
  title: "stale",
  url: "https://github.com/owner/repo/issues/4",
  roles: [],
  assignees: [],
  claimLabeled: true,
  claim: { by: "cogwork-bot", claimedAtMillis: 1 },
  claimedByUs: true,
  attempts: [],
  handback: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  pr: null,
};

const failedAttempt = (atMillis: number): AttemptRecord => ({
  stage: "implement",
  outcome: "failed",
  atMillis,
});

const withAttempts = (item: ObservedItem, count: number): ObservedItem => ({
  ...item,
  attempts: Array.from({ length: count }, (_, index) => failedAttempt(index + 1)),
});

const okPoll: PollState = { status: "ok" };

const snapshotOf = (
  observed: ReadonlyArray<ObservedItem>,
  poll: PollState = okPoll,
): Reconcile.ReconcileSnapshot => ({
  generation: 1,
  observedAtMillis: 1,
  workspaces: [
    {
      name: wsA.config.name,
      poll,
      eligible: [],
      claimed: [],
      blocked: [],
      needsHuman: [],
      observed,
      availability: [],
    },
  ],
});

const workerLayer = (observed: ReadonlyArray<ObservedItem>, poll: PollState = okPoll) =>
  Layer.succeed(Reconcile.ReconcileWorker, {
    submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    submitAfterCurrent: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    snapshot: Effect.succeed(snapshotOf(observed, poll)),
    invalidateAvailability: () => Effect.void,
  });

const workerSnapshotLayer = (snapshot: Ref.Ref<Reconcile.ReconcileSnapshot>) =>
  Layer.succeed(Reconcile.ReconcileWorker, {
    submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    submitAfterCurrent: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
    snapshot: Ref.get(snapshot),
    invalidateAvailability: () => Effect.void,
  });

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.readOnlyRegistry({ workspaces: [wsA], failures: [] }),
);

const issueTrackerStub = (service: Partial<IssueTrackerService>) =>
  Layer.succeed(IssueTracker, {
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
    handBack: () => Effect.void,
    stalled: () => Effect.void,
    reclassify: () => Effect.void,
    ...service,
  });

const schedulerStub = (
  admitted: Ref.Ref<ReadonlyArray<EligibleWork>>,
  paused?: Ref.Ref<boolean>,
  inFlight?: Ref.Ref<ReadonlySet<WorkItemIdType>>,
) =>
  Layer.succeed(Scheduler.Scheduler, {
    tick: () => Effect.succeed(0),
    awaitIdle: Effect.void,
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: (_workspace, work) => Ref.update(admitted, (xs) => [...xs, work]),
    isInFlight: (_workspace, itemId) =>
      inFlight ? Effect.map(Ref.get(inFlight), (items) => items.has(itemId)) : Effect.succeed(false),
    setScheduling: () => Effect.succeed(Scheduler.initialState),
    setLimit: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 100 }),
    stats: paused
      ? Effect.map(Ref.get(paused), (value) => ({ ...Scheduler.initialState, paused: value }))
      : Effect.succeed(Scheduler.initialState),
    config: Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 100 }),
  });

interface RecoveryDeps {
  readonly observed: ReadonlyArray<ObservedItem>;
  readonly issueTracker?: Partial<IssueTrackerService>;
  readonly ledger: RunLedger.RunLedgerService;
  readonly admitted: Ref.Ref<ReadonlyArray<EligibleWork>>;
  readonly poll?: PollState;
  readonly paused?: Ref.Ref<boolean>;
  readonly inFlight?: Ref.Ref<ReadonlySet<WorkItemIdType>>;
  readonly snapshot?: Ref.Ref<Reconcile.ReconcileSnapshot>;
  readonly availability?: OperationAvailability;
}

const recoveryLayer = (deps: RecoveryDeps) =>
  Recovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer,
        deps.snapshot ? workerSnapshotLayer(deps.snapshot) : workerLayer(deps.observed, deps.poll ?? okPoll),
        schedulerStub(deps.admitted, deps.paused, deps.inFlight),
        Layer.succeed(Executor.Executor, {
          availabilityOf: (_workspace, item) =>
            Effect.succeed(deps.availability ?? { operation: item.stage, available: true, causes: [] }),
          refreshAvailability: () => Effect.succeed([]),
          execute: () => Effect.succeed(false),
        }),
        issueTrackerStub(deps.issueTracker ?? {}),
        RunLedger.publishingLayer.pipe(
          Layer.provide(Layer.succeed(RunLedger.CoreRunLedger, deps.ledger)),
          Layer.provide(DaemonEventBus.layer),
        ),
      ),
    ),
    Layer.provideMerge(DaemonEventBus.layer),
  );

interface LiveRecoveryProbeState {
  readonly admitted: Ref.Ref<ReadonlyArray<EligibleWork>>;
  readonly attempts: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly handoffs: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly inFlight: Ref.Ref<ReadonlySet<WorkItemIdType>>;
  readonly ledger: RunLedger.RunLedgerService;
  readonly released: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly snapshot: Ref.Ref<Reconcile.ReconcileSnapshot>;
}

class LiveRecoveryProbe extends Context.Service<LiveRecoveryProbe, LiveRecoveryProbeState>()(
  "@cogwork/engine/recovery.test/LiveRecoveryProbe",
) {
  static readonly layer = Layer.effect(
    LiveRecoveryProbe,
    Effect.gen(function* () {
      return {
        admitted: yield* Ref.make<ReadonlyArray<EligibleWork>>([]),
        attempts: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        handoffs: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        inFlight: yield* Ref.make<ReadonlySet<WorkItemIdType>>(new Set()),
        ledger: yield* RunLedger.makeMemory,
        released: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        snapshot: yield* Ref.make<Reconcile.ReconcileSnapshot>(snapshotOf([])),
      };
    }),
  );
}

interface UnavailableRecoveryProbeState {
  readonly admitted: Ref.Ref<ReadonlyArray<EligibleWork>>;
  readonly attempts: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly handoffs: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly ledger: RunLedger.RunLedgerService;
  readonly notes: Ref.Ref<ReadonlyArray<string>>;
  readonly released: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
}

class UnavailableRecoveryProbe extends Context.Service<
  UnavailableRecoveryProbe,
  UnavailableRecoveryProbeState
>()("@cogwork/engine/recovery.test/UnavailableRecoveryProbe") {
  static readonly layer = Layer.effect(
    UnavailableRecoveryProbe,
    Effect.gen(function* () {
      return {
        admitted: yield* Ref.make<ReadonlyArray<EligibleWork>>([]),
        attempts: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        handoffs: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        ledger: yield* RunLedger.makeMemory,
        notes: yield* Ref.make<ReadonlyArray<string>>([]),
        released: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
      };
    }),
  );
}

describe("Recovery.recover", () => {
  it.effect("reschedules an interrupted run while holding its claim and recording no attempt", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      const issueTracker: Partial<IssueTrackerService> = {
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        attemptFailed: (_workspace, itemId) => Ref.update(attempts, (xs) => [...xs, itemId]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(yield* Ref.get(released), []);
        assert.deepStrictEqual(yield* Ref.get(attempts), []);
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], issueTracker, ledger, admitted })));
    }),
  );

  it.effect("keeps an unavailable stalled follow-up on its recovery path", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      const stalledFollowUp: ObservedItem = {
        ...claimedByUs,
        roles: [],
        claim: { by: "cogwork-bot", claimedAtMillis: 1, stage: "follow-up" },
        pr: {
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          review: "pending",
          checks: "failing",
          latestHumanCommentAtMillis: null,
          latestBotTriggerAtMillis: null,
          fresh: false,
          baseDivergence: "none",
          waitingSinceMillis: 0,
          headRef: "1-ours",
          followable: true,
          draft: false,
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 0,
            botTriggerAtMillis: 0,
            noProgress: 3,
            baseDivergence: "none",
          },
        },
      };
      yield* ledger.insertRun({ ...interrupted, stage: "follow-up" });
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();

        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map(({ stage }) => stage),
          ["follow-up"],
        );
        assert.deepStrictEqual(yield* Ref.get(released), []);
      }).pipe(
        Effect.provide(
          recoveryLayer({
            observed: [stalledFollowUp],
            ledger,
            admitted,
            issueTracker: {
              release: (_workspace, itemId) => Ref.update(released, (items) => [...items, itemId]),
            },
            availability: {
              operation: "follow-up",
              available: false,
              causes: [],
            },
          }),
        ),
      );
    }),
  );

  it.effect("hands the rescheduled run its persisted session and a continuation reason", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun({ ...interrupted, session });
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const [work] = yield* Ref.get(admitted);
        assert.deepStrictEqual(work?.resume, { session, reason: "interrupted" });
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted })));
    }),
  );

  it.effect("reschedules without a resume context when the interrupted run left no session", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const [work] = yield* Ref.get(admitted);
        assert.isUndefined(work?.resume);
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted })));
    }),
  );

  it.effect("never escalates an interrupted item to a human, even one attempt from exhaustion", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const handoffs = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      const issueTracker: Partial<IssueTrackerService> = {
        attemptFailed: (_workspace, itemId) => Ref.update(attempts, (xs) => [...xs, itemId]),
        handOff: (_workspace, itemId) => Ref.update(handoffs, (xs) => [...xs, itemId]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(yield* Ref.get(attempts), []);
        assert.deepStrictEqual(yield* Ref.get(handoffs), []);
      }).pipe(
        Effect.provide(
          recoveryLayer({ observed: [withAttempts(claimedByUs, 2)], issueTracker, ledger, admitted }),
        ),
      );
    }),
  );

  it.effect("releases only stale claims left by this daemon and records a recovery attempt", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<{ item: string; reason?: string }>>([]);
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      const issueTracker: Partial<IssueTrackerService> = {
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        attemptFailed: (_workspace, itemId, outcome) =>
          Ref.update(attempts, (xs) => [...xs, { item: itemId, reason: outcome.reason }]),
        note: (_workspace, _itemId, detail) => Ref.update(notes, (xs) => [...xs, detail]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(yield* Ref.get(released), [id("#1")]);
        assert.deepStrictEqual(yield* Ref.get(attempts), [{ item: id("#1"), reason: recoveryReason }]);
        assert.deepStrictEqual(yield* Ref.get(notes), []);
      }).pipe(
        Effect.provide(
          recoveryLayer({
            observed: [claimedByUs, claimedByOther, unclaimed],
            issueTracker,
            ledger,
            admitted,
          }),
        ),
      );
    }),
  );

  it.effect("writes the stale-recovery prose through the note primitive when no stage survives", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const handoffs = yield* Ref.make<ReadonlyArray<string>>([]);
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      const issueTracker: Partial<IssueTrackerService> = {
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        attemptFailed: (_workspace, itemId) => Ref.update(attempts, (xs) => [...xs, itemId]),
        handOff: (_workspace, itemId) => Ref.update(handoffs, (xs) => [...xs, itemId]),
        note: (_workspace, _itemId, detail) => Ref.update(notes, (xs) => [...xs, detail]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const note = (yield* Ref.get(notes))[0] ?? "";
        assert.include(note, "Recovered a stale claim after a daemon restart.");
        assert.include(note, recoveryReason);
        assert.deepStrictEqual(yield* Ref.get(released), [id("#4")]);
        assert.deepStrictEqual(yield* Ref.get(attempts), []);
        assert.deepStrictEqual(yield* Ref.get(handoffs), []);
      }).pipe(Effect.provide(recoveryLayer({ observed: [staleNoStage], issueTracker, ledger, admitted })));
    }),
  );

  it.effect("hands an exhausted recovery the resume handle its session kept before the daemon died", () =>
    Effect.gen(function* () {
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertSession({
        kind: "opaque-handle",
        id: session,
        workspace: wsA.config.name,
        harness: interruptedRun.harness,
        createdAtMillis: 1,
        handle: "cursor-abc",
      });
      yield* ledger.insertRun({ ...interruptedRun, status: "failed", endedAtMillis: 2, session });
      const issueTracker: Partial<IssueTrackerService> = {
        handOff: (_workspace, _itemId, outcome) => Ref.update(notes, (xs) => [...xs, outcome.note ?? ""]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.include((yield* Ref.get(notes))[0] ?? "", "agent --resume 'cursor-abc'");
      }).pipe(
        Effect.provide(
          recoveryLayer({ observed: [withAttempts(claimedByUs, 2)], issueTracker, ledger, admitted }),
        ),
      );
    }),
  );

  it.effect("hands an exhausted recovery to a human with a handoff note", () =>
    Effect.gen(function* () {
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      const issueTracker: Partial<IssueTrackerService> = {
        handOff: (_workspace, _itemId, outcome) =>
          Effect.gen(function* () {
            yield* Ref.update(notes, (xs) => [...xs, outcome.note ?? ""]);
            yield* Ref.update(stages, (xs) => [...xs, outcome.stage]);
          }),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const note = (yield* Ref.get(notes))[0] ?? "";
        assert.include(note, "Exhausted after 3 failed implement attempts");
        assert.include(note, recoveryReason);
        assert.deepStrictEqual(yield* Ref.get(stages), ["implement"]);
      }).pipe(
        Effect.provide(
          recoveryLayer({ observed: [withAttempts(claimedByUs, 2)], issueTracker, ledger, admitted }),
        ),
      );
    }),
  );

  it.effect("marks a run still running at startup as crashed and reschedules it, recording no attempt", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interruptedRun);
      const issueTracker: Partial<IssueTrackerService> = {
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        attemptFailed: (_workspace, itemId) => Ref.update(attempts, (xs) => [...xs, itemId]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
        assert.deepStrictEqual(yield* Ref.get(released), []);
        assert.deepStrictEqual(yield* Ref.get(attempts), []);
        assert.strictEqual((yield* ledger.getRun(interruptedRun.id))?.status, "crashed");
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], issueTracker, ledger, admitted })));
    }),
  );

  it.effect("hands a rescheduled crash its persisted session and a crashed reason", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun({ ...crashedRun("crash-live", 1, "running"), session });
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const [work] = yield* Ref.get(admitted);
        assert.deepStrictEqual(work?.resume, { session, reason: "crashed" });
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted })));
    }),
  );

  it.effect("resumes a fresh crash when an earlier success reset the crash count", () =>
    Effect.gen(function* () {
      const handoffs = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* ledger.insertRun(crashedRun("ok", 3, "succeeded"));
      yield* ledger.insertRun(crashedRun("crash-c", 4, "running"));
      const issueTracker: Partial<IssueTrackerService> = {
        handOff: (_workspace, itemId) => Ref.update(handoffs, (xs) => [...xs, itemId]),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
        assert.deepStrictEqual(yield* Ref.get(handoffs), []);
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], issueTracker, ledger, admitted })));
    }),
  );

  it.effect("caps a crash loop, escalating to a human without an attempt and releasing the claim", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const notes = yield* Ref.make<ReadonlyArray<string>>([]);
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = [];
      const ledger = yield* RunLedger.makeMemory;
      const cappedMetric = Metric.withAttributes(crashLoopsCapped, { stage: "implement" });
      const cappedBefore = (yield* Metric.value(cappedMetric)).count;
      const running = crashedRun("crash-c", 3, "running");
      yield* ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* ledger.insertRun(running);
      const issueTracker: Partial<IssueTrackerService> = {
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
        attemptFailed: (_workspace, itemId) => Ref.update(attempts, (xs) => [...xs, itemId]),
        handOff: (_workspace, _itemId, outcome) =>
          Effect.gen(function* () {
            yield* Ref.update(notes, (xs) => [...xs, outcome.note ?? ""]);
            yield* Ref.update(stages, (xs) => [...xs, outcome.stage]);
          }),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover().pipe(
          Effect.withLogger(
            Logger.make(({ fiber, message }) =>
              logs.push({
                message,
                annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
              }),
            ),
          ),
        );
        const note = (yield* Ref.get(notes))[0] ?? "";
        assert.include(note, "Exhausted after 3 consecutive implement crashes");
        assert.include(note, recoveryReason);
        assert.deepStrictEqual(yield* Ref.get(stages), ["implement"]);
        assert.deepStrictEqual(yield* Ref.get(released), [id("#1")]);
        assert.deepStrictEqual(yield* Ref.get(attempts), []);
        assert.deepStrictEqual(yield* Ref.get(admitted), []);
        assert.strictEqual((yield* ledger.getRun(running.id))?.status, "crashed");
        assert.strictEqual((yield* Metric.value(cappedMetric)).count, cappedBefore + 1);
        const capped = logs.find(({ message }) =>
          Array.isArray(message) ? message.includes("crash loop capped") : message === "crash loop capped",
        );
        assert.deepStrictEqual(capped?.annotations, {
          workspace: "a",
          item: "#1",
          stage: "implement",
        });
        assert.deepStrictEqual(capped?.message, ["crash loop capped", { crashes: 3 }]);
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], issueTracker, ledger, admitted })));
    }),
  );

  it.effect("releases an unavailable resume when its note fails", () =>
    Effect.gen(function* () {
      const probe = yield* UnavailableRecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-c", 3, "running"));
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      const note = (yield* Ref.get(probe.notes))[0] ?? "";
      assert.include(note, "Required skill need is unbound.");
      assert.notInclude(note, "@security-team");
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.map(UnavailableRecoveryProbe, (probe) =>
            recoveryLayer({
              observed: [claimedByUs],
              ledger: probe.ledger,
              admitted: probe.admitted,
              issueTracker: {
                release: (_workspace, itemId) => Ref.update(probe.released, (items) => [...items, itemId]),
                attemptFailed: (_workspace, itemId) =>
                  Ref.update(probe.attempts, (items) => [...items, itemId]),
                handOff: (_workspace, itemId) => Ref.update(probe.handoffs, (items) => [...items, itemId]),
                note: (_workspace, _itemId, detail) =>
                  Ref.update(probe.notes, (items) => [...items, detail]).pipe(
                    Effect.andThen(
                      Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "note failed" })),
                    ),
                  ),
              },
              availability: {
                operation: "implement",
                available: false,
                causes: [
                  {
                    _tag: "UnsatisfiedNeed",
                    need: "review",
                    kind: "skill",
                    reason: "unbound",
                    contribution: null,
                    message: "@security-team [click](https://attacker.invalid)",
                  },
                ],
              },
            }),
          ),
        ).pipe(Layer.provideMerge(UnavailableRecoveryProbe.layer)),
      ),
    ),
  );

  it.effect("defers recovery for a workspace whose bootstrap poll is paused", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      const logged: Array<string> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(yield* Ref.get(admitted), []);
      }).pipe(
        Effect.provide(
          recoveryLayer({
            observed: [],
            ledger,
            admitted,
            poll: { status: "paused", reason: "rate-limited", message: "backing off", retryAtMillis: null },
          }),
        ),
        Effect.withLogger(Logger.make(({ message }) => void logged.push(String(message)))),
      );
      assert.isTrue(logged.some((line) => line.includes("claim recovery deferred")));
    }),
  );

  it.effect("skips a workspace whose claim recovery hits an issue-tracker error", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      const issueTracker: Partial<IssueTrackerService> = {
        attemptFailed: () => Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "boom" })),
      };
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        assert.deepStrictEqual(yield* Ref.get(admitted), []);
      }).pipe(
        Effect.provide(
          recoveryLayer({ observed: [withAttempts(claimedByUs, 0)], issueTracker, ledger, admitted }),
        ),
      );
    }),
  );

  it.effect("announces the crash on the bus when it marks a still-running run crashed", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interruptedRun);
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const events = yield* Stream.fromSubscription(subscription).pipe(
          Stream.takeUntil((event) => DaemonEvent.guards.RunChanged(event) && event.run.status === "crashed"),
          Stream.runCollect,
        );
        const changed = [...events].flatMap((event) =>
          DaemonEvent.guards.RunChanged(event) ? [event.run] : [],
        );
        assert.deepStrictEqual(
          changed.map((run) => run.status),
          ["crashed"],
        );
        assert.strictEqual(changed.at(0)?.id, interruptedRun.id);
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted })), Effect.scoped);
    }),
  );

  it.effect("announces a stale-close on the bus for a leftover run it still finds running", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(crashedRun("stale-a", 1, "running"));
      yield* ledger.insertRun(crashedRun("done-b", 2, "succeeded"));
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        const recovery = yield* Recovery.Recovery;
        yield* recovery.recover();
        const events = yield* Stream.fromSubscription(subscription).pipe(
          Stream.takeUntil((event) => DaemonEvent.guards.RunChanged(event) && event.run.status === "failed"),
          Stream.runCollect,
        );
        const changed = [...events].flatMap((event) =>
          DaemonEvent.guards.RunChanged(event) ? [event.run] : [],
        );
        assert.deepStrictEqual(
          changed.map((run) => run.status),
          ["failed"],
        );
        assert.strictEqual(changed.at(0)?.id, rid("stale-a"));
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted })), Effect.scoped);
    }),
  );
});

describe("Recovery.recoverWhenLive", () => {
  it.effect("recovers a workspace that becomes live after bootstrap", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const snapshot = yield* Ref.make<Reconcile.ReconcileSnapshot>({
        generation: 1,
        observedAtMillis: 1,
        workspaces: [],
      });
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;

        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(yield* Ref.get(admitted), []);

        yield* Ref.set(snapshot, snapshotOf([claimedByUs]));
        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
      }).pipe(Effect.provide(recoveryLayer({ observed: [], ledger, admitted, snapshot })));
    }),
  );

  it.effect("waits for a reconciled snapshot before consuming one-shot recovery", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const snapshot = yield* Ref.make<Reconcile.ReconcileSnapshot>({
        generation: 0,
        observedAtMillis: 0,
        workspaces: [],
      });
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;

        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(yield* Ref.get(admitted), []);

        yield* Ref.set(snapshot, snapshotOf([claimedByUs]));
        yield* recovery.recoverWhenLive();
        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
      }).pipe(Effect.provide(recoveryLayer({ observed: [], ledger, admitted, snapshot })));
    }),
  );

  it.effect("holds recovery while scheduling is paused, then resumes it once, when live", () =>
    Effect.gen(function* () {
      const admitted = yield* Ref.make<ReadonlyArray<EligibleWork>>([]);
      const paused = yield* Ref.make(true);
      const ledger = yield* RunLedger.makeMemory;
      yield* ledger.insertRun(interrupted);
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.Recovery;

        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(yield* Ref.get(admitted), []);

        yield* Ref.set(paused, false);
        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );

        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(
          (yield* Ref.get(admitted)).map((work) => work.id),
          [id("#1")],
        );
      }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs], ledger, admitted, paused })));
    }),
  );

  it.layer(
    Layer.unwrap(
      Effect.map(LiveRecoveryProbe, (probe) =>
        recoveryLayer({
          observed: [],
          admitted: probe.admitted,
          inFlight: probe.inFlight,
          ledger: probe.ledger,
          snapshot: probe.snapshot,
          issueTracker: {
            release: (_workspace, itemId) => Ref.update(probe.released, (items) => [...items, itemId]),
            attemptFailed: (_workspace, itemId) => Ref.update(probe.attempts, (items) => [...items, itemId]),
            handOff: (_workspace, itemId) => Ref.update(probe.handoffs, (items) => [...items, itemId]),
          },
        }),
      ),
    ).pipe(Layer.provideMerge(LiveRecoveryProbe.layer)),
  )((it) => {
    it.effect(
      "releases a newly observed orphan claim after an earlier run without recording an attempt",
      () =>
        Effect.gen(function* () {
          const probe = yield* LiveRecoveryProbe;
          const recovery = yield* Recovery.Recovery;
          const prior = crashedRun("prior-success", 1, "succeeded");
          yield* Effect.all(
            [
              Ref.set(probe.attempts, []),
              Ref.set(probe.inFlight, new Set()),
              Ref.set(probe.released, []),
              Ref.set(probe.snapshot, snapshotOf([])),
            ],
            { discard: true },
          );
          yield* probe.ledger.insertRun(prior);
          yield* recovery.recoverWhenLive();
          yield* Ref.set(probe.snapshot, { ...snapshotOf([withAttempts(claimedByUs, 2)]), generation: 2 });
          yield* recovery.recoverWhenLive();
          yield* recovery.recoverWhenLive();

          assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
          assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
          assert.deepStrictEqual(
            (yield* probe.ledger.listRuns(10)).map((run) => run.id),
            [prior.id],
          );
        }),
    );

    it.effect("retries after a handback without counting earlier crashes", () =>
      Effect.gen(function* () {
        const probe = yield* LiveRecoveryProbe;
        const recovery = yield* Recovery.Recovery;
        yield* Effect.all(
          [
            Ref.set(probe.admitted, []),
            Ref.set(probe.handoffs, []),
            Ref.set(
              probe.snapshot,
              snapshotOf([{ ...claimedByUs, handback: { by: "local-owner", atMillis: 2 } }]),
            ),
          ],
          { discard: true },
        );
        yield* probe.ledger.insertRun(crashedRun("handback-crash-a", 1, "crashed"));
        yield* probe.ledger.insertRun(crashedRun("handback-crash-b", 2, "crashed"));
        yield* probe.ledger.insertRun(crashedRun("handback-crash-c", 3, "running"));
        yield* recovery.recover();

        assert.deepStrictEqual(
          (yield* Ref.get(probe.admitted)).map((work) => work.id),
          [id("#1")],
        );
        assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
      }),
    );

    it.effect("holds an orphan claim while its work item is in flight", () =>
      Effect.gen(function* () {
        const probe = yield* LiveRecoveryProbe;
        const recovery = yield* Recovery.Recovery;
        yield* Effect.all(
          [Ref.set(probe.attempts, []), Ref.set(probe.released, []), Ref.set(probe.snapshot, snapshotOf([]))],
          { discard: true },
        );
        yield* Ref.set(probe.inFlight, new Set([id("#1")]));
        yield* recovery.recoverWhenLive();
        yield* Ref.set(probe.snapshot, { ...snapshotOf([claimedByUs]), generation: 2 });
        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(yield* Ref.get(probe.released), []);

        yield* Ref.set(probe.inFlight, new Set());
        yield* Ref.set(probe.snapshot, { ...snapshotOf([claimedByUs]), generation: 3 });
        yield* recovery.recoverWhenLive();
        assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
      }),
    );
  });
});
