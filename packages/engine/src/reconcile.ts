import {
  type BlockedItem,
  type ClaimedItem,
  type ConnectionId,
  type NeedsHumanItem,
  type OperationAvailability,
  type PollPauseReason,
  PollState,
  type ReadyToMergeItem,
  type WorkspaceId,
  type WorkspaceRegistrationError,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import { Availability } from "./availability";
import { type Classification, classify, type EligibleWork } from "./classify";
import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";
import * as Cooldown from "./cooldown";
import { DaemonEventBus } from "./daemon-event-bus";
import { IssueTracker, type IssueTrackerError, type ObservedItem } from "./issue-tracker";
import { observeWorkspace } from "./observe";
import { OperationResolution } from "./operation-resolution";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { SourceControlProvider } from "./source-control";

const rateLimitHits = Metric.counter("cogwork_reconcile_rate_limit_hits_total", {
  description: "Rate-limit responses observed while polling issue trackers.",
});
export const reconcilePollDuration = Metric.timer("cogwork_reconcile_poll_duration", {
  description: "Time to poll and classify one workspace.",
});
export const reconcileObservedItems = Metric.histogram("cogwork_reconcile_observed_items", {
  description: "Observed work items returned by each successful workspace poll.",
  boundaries: [0, 1, 5, 10, 25, 50, 100, 250],
});

const submitTimeout = "30 seconds";

export interface ReconcileReceipt {
  readonly workspaces: number;
  readonly failures: number;
  readonly pendingWork: number;
  readonly paused: number;
}

export interface WorkspaceReconcileState {
  readonly name: WorkspaceId;
  readonly poll: PollState;
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly blocked: ReadonlyArray<BlockedItem>;
  readonly needsHuman: ReadonlyArray<NeedsHumanItem>;
  readonly readyToMerge: ReadonlyArray<ReadyToMergeItem>;
  readonly observed: ReadonlyArray<ObservedItem>;
  readonly observedCount: number;
  readonly availability: ReadonlyArray<OperationAvailability>;
}

export interface ReconcileSnapshot {
  readonly generation: number;
  readonly observedAtMillis: number;
  readonly workspaces: ReadonlyArray<WorkspaceReconcileState>;
}

type ReconcileReceiptDeferred = Deferred.Deferred<ReconcileReceipt, WorkspaceRegistrationError>;

interface ReconcileJob {
  readonly receipt: ReconcileReceiptDeferred;
}

interface ReceiptSelection {
  readonly receipt: ReconcileReceiptDeferred;
  readonly enqueue: boolean;
}

const okState = (
  workspace: RegisteredWorkspace,
  observed: ReadonlyArray<ObservedItem>,
  classified: Classification,
  availability: ReadonlyArray<OperationAvailability>,
): WorkspaceReconcileState => ({
  name: workspace.config.name,
  poll: { status: "ok" },
  eligible: classified.eligible,
  claimed: classified.claimed,
  blocked: classified.blocked,
  needsHuman: classified.needsHuman,
  readyToMerge: classified.readyToMerge,
  observed,
  observedCount: observed.length,
  availability,
});

interface Pause {
  readonly reason: PollPauseReason;
  readonly message: string;
  readonly retryAtMillis: number | null;
}

const pausedState = (workspace: RegisteredWorkspace, pause: Pause): WorkspaceReconcileState => ({
  name: workspace.config.name,
  poll: { status: "paused", ...pause },
  eligible: [],
  claimed: [],
  blocked: [],
  needsHuman: [],
  readyToMerge: [],
  observed: [],
  observedCount: 0,
  availability: [],
});

interface PauseTiming {
  readonly entered: boolean;
  readonly retryAtMillis: number | null;
}
const connectionIdsOf = (workspace: RegisteredWorkspace) => [
  ...new Set(
    [workspace.config.issueTracker.connectionId, workspace.config.sourceControl?.connectionId].filter(
      (connectionId): connectionId is ConnectionId =>
        connectionId !== undefined && connectionId !== "unbound",
    ),
  ),
];

const makeWithRefresh = Effect.fn("ReconcileWorker.make")(function* <E>(
  refreshAvailability?: (
    workspace: RegisteredWorkspace,
  ) => Effect.Effect<ReadonlyArray<OperationAvailability>, E, never>,
) {
  const registry = yield* WorkspaceRegistry;
  const issueTracker = yield* IssueTracker;
  const provider = yield* SourceControlProvider;
  const connections = yield* ConnectionStore;
  const controlStore = yield* ControlStore;
  const bus = yield* DaemonEventBus;
  const availability = yield* Availability;
  const refresh = refreshAvailability ?? availability.current;
  const refreshedAvailability = Effect.fn("ReconcileWorker.refreshAvailability")(
    (workspace: RegisteredWorkspace) =>
      refresh(workspace).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Operation availability refresh failed", { error }).pipe(
            Effect.andThen(availability.current(workspace)),
          ),
        ),
      ),
  );
  const observe = observeWorkspace(issueTracker, provider);
  const queue = yield* Queue.make<ReconcileJob>();
  const pendingReceipt = yield* Ref.make<ReconcileReceiptDeferred | null>(null);
  const snapshotRef = yield* Ref.make<ReconcileSnapshot>({
    generation: 0,
    observedAtMillis: 0,
    workspaces: [],
  });
  const cooldowns = yield* Cooldown.make;

  const heldCooldown = (scope: string | null) =>
    scope === null ? Effect.succeed(null) : cooldowns.heldUntil(scope);

  // Only the first failure into a window logs, so a pinned credential does not warn on every tick.
  const enterCooldown = (
    scope: string | null,
    nowMillis: number,
    retryAfterMillis: number | undefined,
  ): Effect.Effect<PauseTiming> => {
    if (scope === null) {
      const retryAtMillis = retryAfterMillis === undefined ? null : nowMillis + retryAfterMillis;
      return Effect.succeed({ entered: true, retryAtMillis });
    }
    return cooldowns.enter(scope, retryAfterMillis);
  };

  const pauseForRateLimit = Effect.fn("ReconcileWorker.pauseForRateLimit")(function* (
    workspace: RegisteredWorkspace,
    scope: string | null,
    error: IssueTrackerError,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    yield* Metric.update(Metric.withAttributes(rateLimitHits, { scope: scope ?? "global" }), 1);
    const { entered, retryAtMillis } = yield* enterCooldown(scope, nowMillis, error.retryAfterMillis);
    if (entered) {
      yield* Effect.logWarning("work source rate limited; backing off", {
        scope,
        message: error.message,
        retryAtMillis,
      });
    }
    return pausedState(workspace, { reason: "rate-limited", message: error.message, retryAtMillis });
  });

  const pauseFor = Effect.fn("ReconcileWorker.pauseFor")(function* (
    workspace: RegisteredWorkspace,
    scope: string | null,
    error: IssueTrackerError,
  ) {
    if (error.reason === "rate-limited") {
      return yield* pauseForRateLimit(workspace, scope, error);
    }
    if (error.reason === "auth") {
      yield* (error.connectionId ? connections.revoke(error.connectionId) : Effect.void).pipe(Effect.ignore);
      yield* Effect.gen(function* () {
        const picture = yield* controlStore.picture;
        yield* bus.publish({ _tag: "ControlStoreChanged", controlStore: picture });
      }).pipe(Effect.ignore);
      yield* Effect.gen(function* () {
        const overview = yield* connections.overview;
        yield* bus.publish({ _tag: "ConnectionsChanged", connections: overview, danglingWorkspaces: [] });
      }).pipe(Effect.ignore);
    }
    yield* Effect.logWarning("work source polling paused", {
      reason: error.reason,
      message: error.message,
    });
    return pausedState(workspace, { reason: error.reason, message: error.message, retryAtMillis: null });
  });

  const clearCooldown = (scope: string | null) => (scope === null ? Effect.void : cooldowns.clear(scope));

  const pollReadyWorkspace = Effect.fn("ReconcileWorker.pollReadyWorkspace")(function* (
    workspace: RegisteredWorkspace,
  ) {
    const scope = issueTracker.rateLimitScope(workspace);
    const heldUntilMillis = yield* heldCooldown(scope);
    if (heldUntilMillis !== null) {
      return pausedState(workspace, {
        reason: "rate-limited",
        message: `waiting out the ${scope} rate limit window`,
        retryAtMillis: heldUntilMillis,
      });
    }
    return yield* observe(workspace).pipe(
      Effect.tap(() => clearCooldown(scope)),
      Effect.flatMap((items) =>
        refreshedAvailability(workspace).pipe(
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(reconcileObservedItems, { workspace: workspace.config.name }),
              items.length,
            ),
          ),
          Effect.map((current) =>
            okState(
              workspace,
              items,
              classify(
                items,
                workspace.config.issueTracker.assigneeAllowlist,
                new Map(current.map((entry) => [entry.operation, entry])),
              ),
              current,
            ),
          ),
        ),
      ),
      Effect.catchTag("IssueTrackerError", (error) => pauseFor(workspace, scope, error)),
    );
  });

  const pollWorkspace = Effect.fn("ReconcileWorker.pollWorkspace")(function* (
    workspace: RegisteredWorkspace,
  ) {
    return yield* Effect.forEach(
      connectionIdsOf(workspace),
      (connectionId) => connections.requireReady(connectionId),
      { discard: true },
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            pausedState(workspace, {
              reason: "auth",
              message: error.message,
              retryAtMillis: null,
            }),
          ),
        onSuccess: () => pollReadyWorkspace(workspace),
      }),
    );
  }, Effect.trackDuration(reconcilePollDuration));

  const reconcile = Effect.fn("ReconcileWorker.reconcile")(function* () {
    const state = yield* registry.refresh;
    const states = yield* Effect.forEach(
      state.workspaces,
      (workspace) => {
        const correlation = { workspace: workspace.config.name };
        return pollWorkspace(workspace).pipe(
          Effect.annotateLogs(correlation),
          Effect.annotateSpans(correlation),
          Effect.provideService(References.TracerEnabled, false),
        );
      },
      { concurrency: 4 },
    );
    const observedAtMillis = yield* Clock.currentTimeMillis;
    yield* Ref.update(snapshotRef, (previous) => ({
      generation: previous.generation + 1,
      observedAtMillis,
      workspaces: states,
    }));
    return {
      workspaces: state.workspaces.length,
      failures: state.failures.length,
      pendingWork: states.reduce((total, state) => total + state.eligible.length, 0),
      paused: states.filter((state) => PollState.guards.paused(state.poll)).length,
    };
  });

  const clearPendingReceipt = (receipt: ReconcileReceiptDeferred) =>
    Ref.update(pendingReceipt, (pending) => (pending === receipt ? null : pending));

  const settleReceiptSuccess = (receipt: ReconcileReceiptDeferred, value: ReconcileReceipt) =>
    clearPendingReceipt(receipt).pipe(Effect.andThen(Deferred.succeed(receipt, value)));

  const settleReceiptFailure = (
    receipt: ReconcileReceiptDeferred,
    cause: Cause.Cause<WorkspaceRegistrationError>,
  ) => {
    if (Cause.hasInterruptsOnly(cause)) {
      return clearPendingReceipt(receipt).pipe(
        Effect.andThen(Deferred.failCause(receipt, cause)),
        Effect.andThen(Effect.failCause(cause)),
      );
    }
    return Effect.logError("reconcile job failed", { cause }).pipe(
      Effect.andThen(clearPendingReceipt(receipt)),
      Effect.andThen(Deferred.failCause(receipt, cause)),
    );
  };

  const runJob = (job: ReconcileJob) =>
    Effect.uninterruptibleMask((restore) =>
      restore(reconcile()).pipe(
        Effect.flatMap((receipt) => settleReceiptSuccess(job.receipt, receipt)),
        Effect.catchCause((cause) => settleReceiptFailure(job.receipt, cause)),
      ),
    );

  const awaitReceipt = (receipt: ReconcileReceiptDeferred) =>
    Deferred.await(receipt).pipe(
      Effect.timeout(submitTimeout),
      Effect.tapErrorTag("TimeoutError", () =>
        Effect.logError("reconcile submission timed out", { timeout: submitTimeout }),
      ),
    );

  yield* Queue.take(queue).pipe(Effect.flatMap(runJob), Effect.forever, Effect.forkScoped);

  const receiptForSubmit = Effect.fn("ReconcileWorker.receiptForSubmit")(function* () {
    const candidate = yield* Deferred.make<ReconcileReceipt, WorkspaceRegistrationError>();
    const selection = yield* Ref.modify(
      pendingReceipt,
      (pending): readonly [ReceiptSelection, ReconcileReceiptDeferred | null] => {
        if (pending) return [{ receipt: pending, enqueue: false }, pending];
        return [{ receipt: candidate, enqueue: true }, candidate];
      },
    );
    if (selection.enqueue) yield* Queue.offer(queue, { receipt: selection.receipt });
    return selection.receipt;
  });

  const receiptAfterCurrent = Effect.fn("ReconcileWorker.receiptAfterCurrent")(function* () {
    const receipt = yield* Deferred.make<ReconcileReceipt, WorkspaceRegistrationError>();
    yield* Queue.offer(queue, { receipt });
    return receipt;
  });

  const submit = Effect.fn("ReconcileWorker.submit")(function* () {
    const receipt = yield* Effect.uninterruptible(receiptForSubmit());
    return yield* awaitReceipt(receipt);
  });

  const submitAfterCurrent = Effect.fn("ReconcileWorker.submitAfterCurrent")(function* () {
    const receipt = yield* Effect.uninterruptible(receiptAfterCurrent());
    return yield* awaitReceipt(receipt);
  });

  return {
    submit,
    submitAfterCurrent,
    snapshot: Ref.get(snapshotRef),
    invalidateAvailability: availability.invalidate,
  };
});

export const make = makeWithRefresh();

export const makeRefreshing = Effect.gen(function* () {
  const operationResolution = yield* OperationResolution;
  return yield* makeWithRefresh(operationResolution.refreshAvailability);
});

export class ReconcileWorker extends Context.Service<ReconcileWorker, Effect.Success<typeof make>>()(
  "@cogwork/engine/reconcile/ReconcileWorker",
) {}

export const layer = Layer.effect(ReconcileWorker, make).pipe(Layer.provide(Availability.layer));
