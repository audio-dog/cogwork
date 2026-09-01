import type {
  BlockedItem,
  ClaimedItem,
  ConnectionId,
  NeedsHumanItem,
  OperationAvailability,
  PollPauseReason,
  PollState,
  WorkspaceId,
  WorkspaceRegistrationError,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { Availability } from "./availability";
import { type Classification, classify, type EligibleWork } from "./classify";
import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { Executor } from "./executor";

import { IssueTracker, type IssueTrackerError, type ObservedItem } from "./issue-tracker";
import { observeWorkspace } from "./observe";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { SourceControlProvider } from "./source-control";

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
  readonly observed: ReadonlyArray<ObservedItem>;
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
  observed,
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
  observed: [],
  availability: [],
});

interface Cooldown {
  readonly untilMillis: number;
  readonly consecutive: number;
}

interface CooldownEntry {
  readonly entered: boolean;
  readonly retryAtMillis: number | null;
}

const baseBackoffMillis = 60_000;
const maxBackoffMillis = 900_000;

const backoffMillis = (consecutive: number) =>
  Math.min(baseBackoffMillis * 2 ** (consecutive - 1), maxBackoffMillis);

const activeAt = (cooldown: Cooldown | undefined, nowMillis: number) =>
  cooldown !== undefined && cooldown.untilMillis > nowMillis ? cooldown : null;

const withoutScope = (cooldowns: Map<string, Cooldown>, scope: string) => {
  if (!cooldowns.has(scope)) return cooldowns;
  const next = new Map(cooldowns);
  next.delete(scope);
  return next;
};

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
  const cooldowns = yield* Ref.make(new Map<string, Cooldown>());

  const heldCooldown = Effect.fn("ReconcileWorker.heldCooldown")(function* (scope: string | null) {
    if (scope === null) return null;
    const nowMillis = yield* Clock.currentTimeMillis;
    return activeAt((yield* Ref.get(cooldowns)).get(scope), nowMillis);
  });

  // Only the first failure into a window logs, so a pinned credential does not warn on every tick.
  const enterCooldown = (
    scope: string | null,
    nowMillis: number,
    retryAfterMillis: number | undefined,
  ): Effect.Effect<CooldownEntry> => {
    if (scope === null) {
      const retryAtMillis = retryAfterMillis === undefined ? null : nowMillis + retryAfterMillis;
      return Effect.succeed({ entered: true, retryAtMillis });
    }
    return Ref.modify(cooldowns, (current): readonly [CooldownEntry, Map<string, Cooldown>] => {
      const held = activeAt(current.get(scope), nowMillis);
      if (held) return [{ entered: false, retryAtMillis: held.untilMillis }, current];
      const consecutive = (current.get(scope)?.consecutive ?? 0) + 1;
      const cooldown: Cooldown = {
        untilMillis: nowMillis + (retryAfterMillis ?? backoffMillis(consecutive)),
        consecutive,
      };
      return [{ entered: true, retryAtMillis: cooldown.untilMillis }, new Map(current).set(scope, cooldown)];
    });
  };

  const pauseForRateLimit = Effect.fn("ReconcileWorker.pauseForRateLimit")(function* (
    workspace: RegisteredWorkspace,
    scope: string | null,
    error: IssueTrackerError,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const { entered, retryAtMillis } = yield* enterCooldown(scope, nowMillis, error.retryAfterMillis);
    if (entered) {
      yield* Effect.logWarning("work source rate limited; backing off", {
        workspace: workspace.config.name,
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
      workspace: workspace.config.name,
      reason: error.reason,
      message: error.message,
    });
    return pausedState(workspace, { reason: error.reason, message: error.message, retryAtMillis: null });
  });

  const clearCooldown = (scope: string | null) =>
    scope === null ? Effect.void : Ref.update(cooldowns, (current) => withoutScope(current, scope));

  const pollReadyWorkspace = Effect.fn("ReconcileWorker.pollReadyWorkspace")(function* (
    workspace: RegisteredWorkspace,
  ) {
    const scope = issueTracker.rateLimitScope(workspace);
    const held = yield* heldCooldown(scope);
    if (held) {
      return pausedState(workspace, {
        reason: "rate-limited",
        message: `waiting out the ${scope} rate limit window`,
        retryAtMillis: held.untilMillis,
      });
    }
    return yield* observe(workspace).pipe(
      Effect.tap(() => clearCooldown(scope)),
      Effect.flatMap((items) =>
        refreshedAvailability(workspace).pipe(
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
  });

  const reconcile = Effect.fn("ReconcileWorker.reconcile")(function* () {
    yield* registry.refresh;
    const states = yield* Effect.forEach(registry.workspaces, pollWorkspace, {
      concurrency: 4,
    });
    const observedAtMillis = yield* Clock.currentTimeMillis;
    yield* Ref.update(snapshotRef, (previous) => ({
      generation: previous.generation + 1,
      observedAtMillis,
      workspaces: states,
    }));
    return {
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
      pendingWork: states.reduce((total, state) => total + state.eligible.length, 0),
      paused: states.filter((state) => state.poll.status === "paused").length,
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
  const executor = yield* Executor;
  return yield* makeWithRefresh(executor.refreshAvailability);
});

export class ReconcileWorker extends Context.Service<ReconcileWorker, Effect.Success<typeof make>>()(
  "@cogwork/engine/reconcile/ReconcileWorker",
) {}

export const layer = Layer.effect(ReconcileWorker, make).pipe(Layer.provide(Availability.layer));
