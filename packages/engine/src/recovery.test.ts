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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { EligibleWork } from "./classify";
import { recoveryReason } from "./comments";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import * as Harness from "./harness";
import type { ObservedItem } from "./issue-tracker";
import {
  type AttemptFailedOutcome,
  type HandOffOutcome,
  IssueTracker,
  IssueTrackerError,
  type IssueTrackerService,
} from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import * as Reconcile from "./reconcile";
import * as Recovery from "./recovery";
import * as Registry from "./registry";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import { engineTestLayer } from "./testing/engine-test-layer";

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

const heldRun: RunRecord = {
  ...interruptedRun,
  status: "failed",
  endedAtMillis: 2,
  claimDisposition: "hold",
};

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

type ObservedPr = NonNullable<ObservedItem["pr"]>;

const pr = (review: ObservedPr["review"], overrides: Partial<ObservedPr> = {}): ObservedPr => ({
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  review,
  checks: "passing",
  latestHumanCommentAtMillis: null,
  latestBotTriggerAtMillis: null,
  fresh: false,
  baseDivergence: "none",
  waitingSinceMillis: 0,
  headRef: "1-ours",
  followable: true,
  draft: false,
  followUp: null,
  ...overrides,
});

const claimedWithPr = (review: ObservedPr["review"], overrides: Partial<ObservedPr> = {}) => ({
  ...claimedByUs,
  roles: [],
  pr: pr(review, overrides),
});

const stalledFollowUp: ObservedItem = {
  ...claimedWithPr("pending", {
    checks: "failing",
    followUp: {
      checks: "failing",
      humanCommentAtMillis: 0,
      botTriggerAtMillis: 0,
      noProgress: 3,
      baseDivergence: "none",
    },
  }),
  claim: { by: "cogwork-bot", claimedAtMillis: 1, stage: "follow-up" },
};

const failedAttempt = (atMillis: number, stage: AttemptRecord["stage"] = "implement"): AttemptRecord => ({
  stage,
  outcome: "failed",
  atMillis,
});

const withAttempts = (
  item: ObservedItem,
  count: number,
  stage: AttemptRecord["stage"] = "implement",
): ObservedItem => ({
  ...item,
  attempts: Array.from({ length: count }, (_, index) => failedAttempt(index + 1, stage)),
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
      readyToMerge: [],
      observed,
      observedCount: observed.length,
      availability: [],
    },
  ],
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

const schedulerStub = (
  admitted: Ref.Ref<ReadonlyArray<EligibleWork>>,
  paused: Ref.Ref<boolean>,
  inFlight: Ref.Ref<ReadonlySet<WorkItemIdType>>,
) =>
  Layer.succeed(Scheduler.Scheduler, {
    tick: () => Effect.succeed(0),
    awaitIdle: Effect.void,
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: (_workspace, work) => Ref.update(admitted, (xs) => [...xs, work]),
    isInFlight: (_workspace, itemId) => Effect.map(Ref.get(inFlight), (items) => items.has(itemId)),
    setScheduling: () => Effect.succeed(Scheduler.initialState),
    setLimit: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 100 }),
    stats: Effect.map(Ref.get(paused), (value) => ({ ...Scheduler.initialState, paused: value })),
    config: Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 100 }),
  });

interface AttemptCall {
  readonly item: WorkItemIdType;
  readonly outcome: AttemptFailedOutcome;
}

interface HandOffCall {
  readonly item: WorkItemIdType;
  readonly outcome: HandOffOutcome;
}

interface RecoveryLog {
  readonly annotations: Record<string, unknown>;
  readonly message: unknown;
}

const recoveryProbeLogger = (logs: Queue.Queue<RecoveryLog>) =>
  Logger.make(({ fiber, message }) => {
    Queue.offerUnsafe(logs, {
      message,
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });

interface RecoveryProbeState {
  readonly admitted: Ref.Ref<ReadonlyArray<EligibleWork>>;
  readonly attempts: Ref.Ref<ReadonlyArray<AttemptCall>>;
  readonly handoffs: Ref.Ref<ReadonlyArray<HandOffCall>>;
  readonly inFlight: Ref.Ref<ReadonlySet<WorkItemIdType>>;
  readonly ledger: RunLedger.CoreRunLedgerService;
  readonly logs: Queue.Queue<RecoveryLog>;
  readonly notes: Ref.Ref<ReadonlyArray<string>>;
  readonly paused: Ref.Ref<boolean>;
  readonly released: Ref.Ref<ReadonlyArray<WorkItemIdType>>;
  readonly snapshot: Ref.Ref<Reconcile.ReconcileSnapshot>;
}

class RecoveryProbe extends Context.Service<RecoveryProbe, RecoveryProbeState>()(
  "@cogwork/engine/recovery.test/RecoveryProbe",
) {
  static readonly layer = Layer.effect(
    RecoveryProbe,
    Effect.gen(function* () {
      return {
        admitted: yield* Ref.make<ReadonlyArray<EligibleWork>>([]),
        attempts: yield* Ref.make<ReadonlyArray<AttemptCall>>([]),
        handoffs: yield* Ref.make<ReadonlyArray<HandOffCall>>([]),
        inFlight: yield* Ref.make<ReadonlySet<WorkItemIdType>>(new Set()),
        ledger: yield* RunLedger.makeMemory,
        logs: yield* Queue.unbounded<RecoveryLog>(),
        notes: yield* Ref.make<ReadonlyArray<string>>([]),
        paused: yield* Ref.make(false),
        released: yield* Ref.make<ReadonlyArray<WorkItemIdType>>([]),
        snapshot: yield* Ref.make<Reconcile.ReconcileSnapshot>({
          generation: 1,
          observedAtMillis: 1,
          workspaces: [],
        }),
      };
    }),
  );
}

interface RecoveryOptions {
  readonly observed: ReadonlyArray<ObservedItem>;
  readonly poll?: PollState;
  readonly availability?: OperationAvailability;
}

const issueTrackerStub = (probe: RecoveryProbeState) =>
  ({
    rateLimitScope: () => null,
    observe: () => Effect.succeed([]),
    createIssue: () => Effect.void,
    claim: () => Effect.void,
    release: (_workspace, item) => Ref.update(probe.released, (items) => [...items, item]),
    note: (_workspace, _item, detail) => Ref.update(probe.notes, (notes) => [...notes, detail]),
    triaged: () => Effect.void,
    implemented: () => Effect.void,
    followedUp: () => Effect.void,
    attemptFailed: (_workspace, item, outcome) =>
      Ref.update(probe.attempts, (calls) => [...calls, { item, outcome }]),
    handOff: (_workspace, item, outcome) =>
      Ref.update(probe.handoffs, (calls) => [...calls, { item, outcome }]),
    handBack: () => Effect.void,
    stalled: () => Effect.void,
    reclassify: () => Effect.void,
  }) satisfies IssueTrackerService;

const noteFailureIssueTracker = (probe: RecoveryProbeState, failure: IssueTrackerError) => {
  const tracker = issueTrackerStub(probe);
  return {
    ...tracker,
    note: (...args: Parameters<IssueTrackerService["note"]>) =>
      tracker.note(...args).pipe(Effect.andThen(Effect.fail(failure))),
  } satisfies IssueTrackerService;
};

const attemptFailureIssueTracker = (probe: RecoveryProbeState, failure: IssueTrackerError) => {
  const tracker = issueTrackerStub(probe);
  return {
    ...tracker,
    attemptFailed: (...args: Parameters<IssueTrackerService["attemptFailed"]>) =>
      tracker.attemptFailed(...args).pipe(Effect.andThen(Effect.fail(failure))),
  } satisfies IssueTrackerService;
};

type MakeIssueTracker = (probe: RecoveryProbeState) => IssueTrackerService;

const makeRecoveryLayer = (options: RecoveryOptions, makeIssueTracker: MakeIssueTracker) =>
  Layer.unwrap(
    Effect.map(RecoveryProbe, (probe) => {
      const engineServices = engineTestLayer({
        coreRunLedger: Layer.succeed(RunLedger.CoreRunLedger, probe.ledger),
      });
      const seedSnapshot = Layer.effectDiscard(
        Ref.set(probe.snapshot, snapshotOf(options.observed, options.poll ?? okPoll)),
      );
      return Recovery.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            engineServices,
            Harness.layer([]),
            registryLayer,
            seedSnapshot,
            workerSnapshotLayer(probe.snapshot),
            schedulerStub(probe.admitted, probe.paused, probe.inFlight),
            Layer.succeed(Executor.Executor, {
              availabilityOf: (_workspace, item) =>
                Effect.succeed(
                  options.availability?.operation === item.stage
                    ? options.availability
                    : { operation: item.stage, available: true, causes: [] },
                ),
              refreshAvailability: () => Effect.succeed([]),
              execute: () => Effect.succeed(false),
            }),
            Layer.succeed(IssueTracker, makeIssueTracker(probe)),
          ),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(RecoveryProbe.layer));

const recoveryLayer = (options: RecoveryOptions) => makeRecoveryLayer(options, issueTrackerStub);

const recoveryLayerWithNoteFailure = (options: RecoveryOptions, failure: IssueTrackerError) =>
  makeRecoveryLayer(options, (probe) => noteFailureIssueTracker(probe, failure));

const recoveryLayerWithAttemptFailure = (options: RecoveryOptions, failure: IssueTrackerError) =>
  makeRecoveryLayer(options, (probe) => attemptFailureIssueTracker(probe, failure));

describe("Recovery.recover", () => {
  it.effect("preserves a claim held by a declined pull request gate", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(heldRun);
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("routes an interrupted implement claim through the current follow-up stage", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map(({ stage }) => stage),
        ["follow-up"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedWithPr("pending", { checks: "failing" })] }))),
  );

  it.effect("routes a crashed implement claim through the current follow-up stage", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interruptedRun);
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map(({ stage }) => stage),
        ["follow-up"],
      );
      assert.strictEqual((yield* probe.ledger.getRun(interruptedRun.id))?.status, "crashed");
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedWithPr("pending", { checks: "failing" })] }))),
  );

  it.effect("settles and releases a claim whose current PR state has no operation", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interruptedRun);
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.strictEqual((yield* probe.ledger.getRun(interruptedRun.id))?.status, "failed");
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedWithPr("pending")] }))),
  );

  it.effect("accounts a terminal run against its actual stage after the current stage changes", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun({ ...interrupted, status: "failed" });
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.attempts)).map(({ outcome }) => outcome.stage),
        ["implement"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [withAttempts(claimedWithPr("pending", { checks: "failing" }), 2, "follow-up")],
        }),
      ),
    ),
  );

  it.effect("ignores a held terminal run that predates the current claim", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun({
        ...interrupted,
        stage: "follow-up",
        status: "failed",
        claimDisposition: "hold",
      });
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.attempts)).map(({ outcome }) => outcome.stage),
        ["implement"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [
            withAttempts(
              {
                ...claimedByUs,
                claim: { by: "cogwork-bot", claimedAtMillis: 2, stage: "implement" },
              },
              2,
              "follow-up",
            ),
          ],
        }),
      ),
    ),
  );

  it.effect("resumes an interrupted run that predates a recovery-refreshed claim", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map(({ stage }) => stage),
        ["follow-up"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [
            {
              ...claimedWithPr("pending", { checks: "failing" }),
              claim: { by: "cogwork-bot", claimedAtMillis: 2, stage: "implement" },
            },
          ],
        }),
      ),
    ),
  );

  it.effect("attributes a capped crash loop to the stage that crashed after the current stage changes", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-c", 3, "running"));
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.handoffs)).map(({ outcome }) => outcome.stage),
        ["implement"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedWithPr("pending", { checks: "failing" })] }))),
  );

  it.effect("reschedules an interrupted run while holding its claim and recording no attempt", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("keeps an unavailable stalled follow-up on its recovery path", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun({ ...interrupted, stage: "follow-up" });
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map(({ stage }) => stage),
        ["follow-up"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [stalledFollowUp],
          availability: { operation: "follow-up", available: false, causes: [] },
        }),
      ),
    ),
  );

  it.effect("hands the rescheduled run its persisted session and a continuation reason", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun({ ...interrupted, session });
      yield* recovery.recover();
      const [work] = yield* Ref.get(probe.admitted);
      assert.deepStrictEqual(work?.resume, { session, reason: "interrupted" });
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("reschedules without a resume context when the interrupted run left no session", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover();
      const [work] = yield* Ref.get(probe.admitted);
      assert.isUndefined(work?.resume);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("never escalates an interrupted item to a human, even one attempt from exhaustion", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [withAttempts(claimedByUs, 2)] }))),
  );

  it.effect("releases only stale claims left by this daemon and records a recovery attempt", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
      assert.deepStrictEqual(
        (yield* Ref.get(probe.attempts)).map(({ item, outcome }) => ({ item, reason: outcome.reason })),
        [{ item: id("#1"), reason: recoveryReason }],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.notes), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs, claimedByOther, unclaimed] }))),
  );

  it.effect("writes the stale-recovery prose through the note primitive when no stage survives", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* recovery.recover();
      const note = (yield* Ref.get(probe.notes))[0] ?? "";
      assert.include(note, "Recovered a stale claim after a daemon restart.");
      assert.include(note, recoveryReason);
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#4")]);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [staleNoStage] }))),
  );

  it.effect("omits human attachment for a recovered programmatic-only session", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertSession({
        kind: "opaque-handle",
        id: session,
        workspace: wsA.config.name,
        harness: interruptedRun.harness,
        createdAtMillis: 1,
        handle: "cursor-abc",
      });
      yield* probe.ledger.insertRun({ ...interruptedRun, status: "failed", endedAtMillis: 2, session });
      yield* recovery.recover();
      assert.notInclude((yield* Ref.get(probe.handoffs))[0]?.outcome.note ?? "", "codex resume");
    }).pipe(Effect.provide(recoveryLayer({ observed: [withAttempts(claimedByUs, 2)] }))),
  );

  it.effect("hands an exhausted recovery to a human with a handoff note", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* recovery.recover();
      const handoffs = yield* Ref.get(probe.handoffs);
      const note = handoffs[0]?.outcome.note ?? "";
      assert.include(note, "Exhausted after 3 failed implement attempts");
      assert.include(note, recoveryReason);
      assert.deepStrictEqual(
        handoffs.map(({ outcome }) => outcome.stage),
        ["implement"],
      );
    }).pipe(Effect.provide(recoveryLayer({ observed: [withAttempts(claimedByUs, 2)] }))),
  );

  it.effect("marks a run still running at startup as crashed and reschedules it, recording no attempt", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interruptedRun);
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.strictEqual((yield* probe.ledger.getRun(interruptedRun.id))?.status, "crashed");
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("hands a rescheduled crash its persisted session and a crashed reason", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun({ ...crashedRun("crash-live", 1, "running"), session });
      yield* recovery.recover();
      const [work] = yield* Ref.get(probe.admitted);
      assert.deepStrictEqual(work?.resume, { session, reason: "crashed" });
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("resumes a fresh crash when an earlier success reset the crash count", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("ok", 3, "succeeded"));
      yield* probe.ledger.insertRun(crashedRun("crash-c", 4, "running"));
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("caps a crash loop, escalating to a human without an attempt and releasing the claim", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      const cappedMetric = Metric.withAttributes(crashLoopsCapped, { stage: "implement" });
      const cappedBefore = (yield* Metric.value(cappedMetric)).count;
      const running = crashedRun("crash-c", 3, "running");
      yield* probe.ledger.insertRun(crashedRun("crash-a", 1, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("crash-b", 2, "crashed"));
      yield* probe.ledger.insertRun(running);
      yield* recovery.recover().pipe(Effect.withLogger(recoveryProbeLogger(probe.logs)));
      const handoffs = yield* Ref.get(probe.handoffs);
      const note = handoffs[0]?.outcome.note ?? "";
      assert.include(note, "Exhausted after 3 consecutive implement crashes");
      assert.include(note, recoveryReason);
      assert.deepStrictEqual(
        handoffs.map(({ outcome }) => outcome.stage),
        ["implement"],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
      assert.deepStrictEqual(yield* Ref.get(probe.attempts), []);
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      assert.strictEqual((yield* probe.ledger.getRun(running.id))?.status, "crashed");
      assert.strictEqual((yield* Metric.value(cappedMetric)).count, cappedBefore + 1);
      const logs = yield* Queue.takeAll(probe.logs);
      const capped = logs.find(({ message }) =>
        Array.isArray(message) ? message.includes("crash loop capped") : message === "crash loop capped",
      );
      assert.deepStrictEqual(capped?.annotations, {
        workspace: "a",
        item: "#1",
        stage: "implement",
      });
      assert.deepStrictEqual(capped?.message, ["crash loop capped", { crashes: 3 }]);
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("releases an unavailable resume when its note fails", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
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
        recoveryLayerWithNoteFailure(
          {
            observed: [claimedByUs],
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
          },
          new IssueTrackerError({ reason: "unavailable", message: "note failed" }),
        ),
      ),
    ),
  );

  it.effect("defers recovery for a workspace whose bootstrap poll is paused", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recover().pipe(Effect.withLogger(recoveryProbeLogger(probe.logs)));
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      const logs = yield* Queue.takeAll(probe.logs);
      assert.isTrue(logs.some(({ message }) => String(message).includes("claim recovery deferred")));
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [],
          poll: { status: "paused", reason: "rate-limited", message: "backing off", retryAtMillis: null },
        }),
      ),
    ),
  );

  it.effect("skips a workspace whose claim recovery hits an issue-tracker error", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* recovery.recover();
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
    }).pipe(
      Effect.provide(
        recoveryLayerWithAttemptFailure(
          { observed: [withAttempts(claimedByUs, 0)] },
          new IssueTrackerError({ reason: "unavailable", message: "boom" }),
        ),
      ),
    ),
  );

  it.effect("announces the crash on the bus when it marks a still-running run crashed", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(interruptedRun);
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
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("announces a stale-close on the bus for a leftover run it still finds running", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(crashedRun("stale-a", 1, "running"));
      yield* probe.ledger.insertRun(crashedRun("done-b", 2, "succeeded"));
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
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );
});

describe("Recovery.recoverWhenLive", () => {
  it.effect("recovers a workspace that becomes live after bootstrap", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* Ref.set(probe.snapshot, { generation: 1, observedAtMillis: 1, workspaces: [] });
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      yield* Ref.set(probe.snapshot, snapshotOf([claimedByUs]));
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
    }).pipe(Effect.provide(recoveryLayer({ observed: [] }))),
  );

  it.effect("waits for a reconciled snapshot before consuming one-shot recovery", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* Ref.set(probe.snapshot, {
        generation: 0,
        observedAtMillis: 0,
        workspaces: [],
      });
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      yield* Ref.set(probe.snapshot, snapshotOf([claimedByUs]));
      yield* recovery.recoverWhenLive();
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
    }).pipe(Effect.provide(recoveryLayer({ observed: [] }))),
  );

  it.effect("holds recovery while scheduling is paused, then resumes it once, when live", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* Ref.set(probe.paused, true);
      yield* probe.ledger.insertRun(interrupted);
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.admitted), []);
      yield* Ref.set(probe.paused, false);
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
    }).pipe(Effect.provide(recoveryLayer({ observed: [claimedByUs] }))),
  );

  it.effect("releases a newly observed orphan claim after an earlier run without recording an attempt", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      const prior = crashedRun("prior-success", 1, "succeeded");
      yield* Ref.set(probe.snapshot, snapshotOf([]));
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
    }).pipe(Effect.provide(recoveryLayer({ observed: [] }))),
  );

  it.effect("preserves a newly observed claim held by a declined pull request gate", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* Ref.set(probe.snapshot, snapshotOf([]));
      yield* probe.ledger.insertRun(heldRun);
      yield* recovery.recoverWhenLive();
      yield* Ref.set(probe.snapshot, { ...snapshotOf([claimedByUs]), generation: 2 });
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
    }).pipe(Effect.provide(recoveryLayer({ observed: [] }))),
  );

  it.effect("retries after a handback without counting earlier crashes", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* probe.ledger.insertRun(crashedRun("handback-crash-a", 1, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("handback-crash-b", 2, "crashed"));
      yield* probe.ledger.insertRun(crashedRun("handback-crash-c", 3, "running"));
      yield* recovery.recover();
      assert.deepStrictEqual(
        (yield* Ref.get(probe.admitted)).map((work) => work.id),
        [id("#1")],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.handoffs), []);
    }).pipe(
      Effect.provide(
        recoveryLayer({
          observed: [{ ...claimedByUs, handback: { by: "local-owner", atMillis: 2 } }],
        }),
      ),
    ),
  );

  it.effect("holds an orphan claim while its work item is in flight", () =>
    Effect.gen(function* () {
      const probe = yield* RecoveryProbe;
      const recovery = yield* Recovery.Recovery;
      yield* Ref.set(probe.snapshot, snapshotOf([]));
      yield* Ref.set(probe.inFlight, new Set([id("#1")]));
      yield* recovery.recoverWhenLive();
      yield* Ref.set(probe.snapshot, { ...snapshotOf([claimedByUs]), generation: 2 });
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.released), []);
      yield* Ref.set(probe.inFlight, new Set());
      yield* Ref.set(probe.snapshot, { ...snapshotOf([claimedByUs]), generation: 3 });
      yield* recovery.recoverWhenLive();
      assert.deepStrictEqual(yield* Ref.get(probe.released), [id("#1")]);
    }).pipe(Effect.provide(recoveryLayer({ observed: [] }))),
  );
});
