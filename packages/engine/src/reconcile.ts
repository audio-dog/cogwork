import type {
  BlockedItem,
  ClaimedItem,
  NeedsHumanItem,
  PollPauseReason,
  PollState,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { type Classification, classify, type EligibleWork } from "./classify";
import { observeWorkspace } from "./observe";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { SourceControlProvider } from "./source-control";
import { type ObservedItem, WorkSource, type WorkSourceError } from "./work-source";

export interface ObservedRef {
  readonly id: WorkItemId;
  readonly title: string;
}

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
  readonly observed: ReadonlyArray<ObservedRef>;
}

export interface ReconcileSnapshot {
  readonly generation: number;
  readonly workspaces: ReadonlyArray<WorkspaceReconcileState>;
}

interface ReconcileJob {
  readonly receipt: Deferred.Deferred<ReconcileReceipt>;
}

const okState = (
  workspace: RegisteredWorkspace,
  observed: ReadonlyArray<ObservedItem>,
  classified: Classification,
): WorkspaceReconcileState => ({
  name: workspace.config.name,
  poll: { status: "ok" },
  eligible: classified.eligible,
  claimed: classified.claimed,
  blocked: classified.blocked,
  needsHuman: classified.needsHuman,
  observed: observed.map((item) => ({ id: item.id, title: item.title })),
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

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const workSource = yield* WorkSource;
  const provider = yield* SourceControlProvider;
  const observe = observeWorkspace(workSource, provider);
  const queue = yield* Queue.make<ReconcileJob>();
  const snapshotRef = yield* Ref.make<ReconcileSnapshot>({ generation: 0, workspaces: [] });
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
    error: WorkSourceError,
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
    error: WorkSourceError,
  ) {
    if (error.reason === "rate-limited") {
      return yield* pauseForRateLimit(workspace, scope, error);
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

  const pollWorkspace = Effect.fn("ReconcileWorker.pollWorkspace")(function* (
    workspace: RegisteredWorkspace,
  ) {
    const scope = workSource.rateLimitScope(workspace);
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
      Effect.map((items) => okState(workspace, items, classify(items))),
      Effect.catchTag("WorkSourceError", (error) => pauseFor(workspace, scope, error)),
    );
  });

  const reconcile = Effect.fn("ReconcileWorker.reconcile")(function* (job: ReconcileJob) {
    const states = yield* Effect.forEach(registry.workspaces, pollWorkspace, {
      concurrency: 4,
    });
    yield* Ref.update(snapshotRef, (previous) => ({
      generation: previous.generation + 1,
      workspaces: states,
    }));
    yield* Deferred.succeed(job.receipt, {
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
      pendingWork: states.reduce((total, state) => total + state.eligible.length, 0),
      paused: states.filter((state) => state.poll.status === "paused").length,
    });
  });

  yield* Queue.take(queue).pipe(Effect.flatMap(reconcile), Effect.forever, Effect.forkScoped);

  const submit = Effect.fn("ReconcileWorker.submit")(function* () {
    const receipt = yield* Deferred.make<ReconcileReceipt>();
    yield* Queue.offer(queue, { receipt });
    return yield* Deferred.await(receipt);
  });

  return { submit, snapshot: Ref.get(snapshotRef) } as const;
});

export class ReconcileWorker extends Context.Service<ReconcileWorker, Effect.Success<typeof make>>()(
  "@clanker-forge/engine/reconcile/ReconcileWorker",
) {}

export const layer = Layer.effect(ReconcileWorker, make);
