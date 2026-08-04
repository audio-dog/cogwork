import type { LifecycleStage, WorkspaceId } from "@clanker-forge/contracts";
import { stagePriority } from "@clanker-forge/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  consecutiveFailures,
  type EligibleWork,
  handoffRoleFor,
  maxAttemptsPerStage,
  observedStage,
} from "./classify";
import { attachCommand, handoffComment, recoveryReason } from "./comments";
import { claimant, Executor } from "./Executor";
import { runnable } from "./Playbook";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker } from "./Reconcile";
import { WorkspaceRegistry } from "./Registry";
import { RunLedger } from "./RunLedger";
import { type ObservedItem, WorkSource } from "./WorkSource";
import { branchName, checkoutPathFor, ticketSlug } from "./Worktree";

export interface SchedulerConfig {
  readonly globalLimit: number;
  readonly dailyBudget: number;
}

export interface SchedulerState {
  readonly global: number;
  readonly perWorkspace: ReadonlyMap<WorkspaceId, number>;
  readonly inflight: ReadonlySet<string>;
  readonly generation: number;
  readonly acted: ReadonlySet<string>;
  readonly budgetDay: number;
  readonly budgetUsed: number;
  readonly stopping: boolean;
}

export const initialState: SchedulerState = {
  global: 0,
  perWorkspace: new Map(),
  inflight: new Set(),
  generation: -1,
  acted: new Set(),
  budgetDay: -1,
  budgetUsed: 0,
  stopping: false,
};

export interface DrainOptions {
  readonly graceMillis: number;
  readonly abort: Effect.Effect<void>;
}

export interface DrainOutcome {
  readonly inFlight: number;
  readonly interrupted: number;
}

const millisPerDay = 86_400_000;

const utcDay = (millis: number) => Math.floor(millis / millisPerDay);

export interface Candidate {
  readonly workspace: RegisteredWorkspace;
  readonly work: EligibleWork;
  readonly workspaceLimit: number;
  readonly keys: ReadonlyArray<string>;
}

const byPriority = (a: Candidate, b: Candidate) =>
  stagePriority.indexOf(a.work.stage) - stagePriority.indexOf(b.work.stage);

const fits = (candidate: Candidate, state: SchedulerState, config: SchedulerConfig) =>
  !state.stopping &&
  state.global < config.globalLimit &&
  (state.perWorkspace.get(candidate.workspace.config.name) ?? 0) < candidate.workspaceLimit &&
  state.budgetUsed < config.dailyBudget &&
  candidate.keys.every((key) => !state.inflight.has(key) && !state.acted.has(key));

const bumped = (map: ReadonlyMap<WorkspaceId, number>, key: WorkspaceId, delta: number) => {
  const next = new Map(map);
  const value = (map.get(key) ?? 0) + delta;
  if (value <= 0) next.delete(key);
  else next.set(key, value);
  return next;
};

const reserve = (state: SchedulerState, candidate: Candidate) => ({
  ...state,
  global: state.global + 1,
  perWorkspace: bumped(state.perWorkspace, candidate.workspace.config.name, 1),
  inflight: new Set([...state.inflight, ...candidate.keys]),
  acted: new Set([...state.acted, ...candidate.keys]),
  budgetUsed: state.budgetUsed + 1,
});

const release = (state: SchedulerState, candidate: Candidate) => ({
  ...state,
  global: Math.max(0, state.global - 1),
  perWorkspace: bumped(state.perWorkspace, candidate.workspace.config.name, -1),
  inflight: new Set([...state.inflight].filter((key) => !candidate.keys.includes(key))),
});

const refundBudget = (state: SchedulerState) => ({
  ...state,
  budgetUsed: Math.max(0, state.budgetUsed - 1),
});

const rolledOver = (state: SchedulerState, day: number) =>
  state.budgetDay === day ? state : { ...state, budgetDay: day, budgetUsed: 0 };

const liveKeys = (state: SchedulerState, candidates: ReadonlyArray<Candidate>) =>
  new Set([...candidates.flatMap((candidate) => candidate.keys), ...state.inflight]);

const atGeneration = (state: SchedulerState, generation: number, candidates: ReadonlyArray<Candidate>) => {
  const carried = state.generation === generation ? state.acted : new Set<string>();
  const live = liveKeys(state, candidates);
  return { ...state, generation, acted: new Set([...carried].filter((key) => live.has(key))) };
};

export interface TickStamp {
  readonly day: number;
  readonly generation: number;
}

const refreshed = (state: SchedulerState, stamp: TickStamp, candidates: ReadonlyArray<Candidate>) =>
  atGeneration(rolledOver(state, stamp.day), stamp.generation, candidates);

export interface Plan {
  readonly state: SchedulerState;
  readonly picks: ReadonlyArray<Candidate>;
}

export const plan = (
  candidates: ReadonlyArray<Candidate>,
  state: SchedulerState,
  config: SchedulerConfig,
  stamp: TickStamp,
) =>
  [...candidates]
    .sort(byPriority)
    .reduce<Plan>(
      (acc, candidate) =>
        fits(candidate, acc.state, config)
          ? { state: reserve(acc.state, candidate), picks: [...acc.picks, candidate] }
          : acc,
      { state: refreshed(state, stamp, candidates), picks: [] },
    );

const keysFor = (workspace: RegisteredWorkspace, work: EligibleWork) => {
  const name = workspace.config.name;
  const branch = branchName({ id: work.id, title: work.title });
  return [`${name}:ticket:${ticketSlug(work.id)}`, `${name}:branch:${branch}`];
};

const candidatesOf = (registry: RegistryState, snapshot: ReconcileSnapshot, config: SchedulerConfig) => {
  const byName = new Map(registry.workspaces.map((workspace) => [workspace.config.name, workspace]));
  return snapshot.workspaces.flatMap((state): ReadonlyArray<Candidate> => {
    const workspace = state.poll.status === "ok" ? byName.get(state.name) : undefined;
    if (!workspace) return [];
    const workspaceLimit = workspace.config.concurrency ?? config.globalLimit;
    return state.eligible
      .filter((work) => runnable(workspace.config, work.stage))
      .map((work) => ({ workspace, work, workspaceLimit, keys: keysFor(workspace, work) }));
  });
};

const checkoutForStage = (workspace: RegisteredWorkspace, item: ObservedItem, stage: LifecycleStage) =>
  checkoutPathFor(workspace.config.checkoutPath, item, stage, workspace.config.worktrees);

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const worker = yield* ReconcileWorker;
    const executor = yield* Executor;
    const workSource = yield* WorkSource;
    const ledger = yield* RunLedger;
    const jobs = yield* FiberSet.make<void>();
    const stateRef = yield* Ref.make(initialState);
    const startedAtMillis = yield* Clock.currentTimeMillis;

    const runJob = (candidate: Candidate) =>
      executor.execute(candidate.workspace, candidate.work).pipe(
        Effect.flatMap((started) => (started ? Effect.void : Ref.update(stateRef, refundBudget))),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("scheduled job crashed", {
              workspace: candidate.workspace.config.name,
              item: candidate.work.id,
              cause,
            }),
        ),
        Effect.ensuring(Ref.update(stateRef, (state) => release(state, candidate))),
      );

    const tick = Effect.fn("Scheduler.tick")(function* () {
      const snapshot = yield* worker.snapshot;
      const candidates = candidatesOf(registry, snapshot, config);
      const day = utcDay(yield* Clock.currentTimeMillis);
      const planned = yield* Ref.modify(stateRef, (state) => {
        const next = plan(candidates, state, config, { day, generation: snapshot.generation });
        return [next, next.state];
      });
      if (planned.picks.length > 0) {
        yield* Effect.logInfo("scheduled jobs", {
          picked: planned.picks.map((c) => ({
            workspace: c.workspace.config.name,
            item: c.work.id,
            stage: c.work.stage,
          })),
          generation: snapshot.generation,
          inFlight: planned.state.global,
          budgetUsed: planned.state.budgetUsed,
        });
      }
      return yield* Effect.forEach(planned.picks, (candidate) => FiberSet.run(jobs, runJob(candidate)));
    });

    const drain = Effect.fn("Scheduler.drain")(function* (options: DrainOptions) {
      yield* Ref.update(stateRef, (state) => ({ ...state, stopping: true }));
      const inFlight = yield* FiberSet.size(jobs);
      yield* Effect.logInfo("draining in-flight runs", {
        inFlight,
        graceMillis: options.graceMillis,
      });
      yield* Effect.raceAll([FiberSet.awaitEmpty(jobs), Effect.sleep(options.graceMillis), options.abort]);
      const interrupted = yield* FiberSet.size(jobs);
      const endedAtMillis = yield* Clock.currentTimeMillis;
      yield* ledger.interruptRunning(startedAtMillis, endedAtMillis);
      yield* FiberSet.clear(jobs);
      yield* Effect.logInfo("drain complete", { inFlight, interrupted });
      return { inFlight, interrupted } satisfies DrainOutcome;
    });

    const handoffRecovery = Effect.fn("Scheduler.handoffRecovery")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      attempts: number,
      session: string | null | undefined,
    ) {
      const role = handoffRoleFor(stage);
      const checkout = checkoutForStage(workspace, item, stage);
      const resume = session === null || session === undefined ? undefined : attachCommand(checkout, session);
      yield* workSource.setRoles(workspace, item.id, {
        remove: role ? [role] : [],
        add: ["ready-for-human"],
      });
      yield* workSource.note(
        workspace,
        item.id,
        handoffComment(stage, { kind: "max-attempts", attempts }, recoveryReason, resume),
      );
    });

    const recordRecovery = Effect.fn("Scheduler.recordRecovery")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      endedAtMillis: number,
      session: string | null | undefined,
    ) {
      const attempts = consecutiveFailures(item, stage) + 1;
      const exhausted = attempts >= maxAttemptsPerStage;
      yield* Effect.logWarning("recovered stale claim", {
        workspace: workspace.config.name,
        item: item.id,
        stage,
        reason: recoveryReason,
        attempts,
        exhausted,
      });
      yield* workSource.recordAttempt(
        workspace,
        item.id,
        { stage, outcome: "failed", atMillis: endedAtMillis },
        recoveryReason,
      );
      if (!exhausted) return;
      yield* handoffRecovery(workspace, item, stage, attempts, session);
    });

    const recoverStale = Effect.fn("Scheduler.recoverStale")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
    ) {
      const stage = observedStage(item);
      const endedAtMillis = yield* Clock.currentTimeMillis;
      const last = yield* ledger.latestRunForItem(workspace.config.name, item.id);
      yield* ledger.closeRunning(workspace.config.name, item.id, endedAtMillis);
      const recover = stage
        ? recordRecovery(workspace, item, stage, endedAtMillis, last?.session)
        : Effect.gen(function* () {
            yield* Effect.logInfo("recovered stale claim", {
              workspace: workspace.config.name,
              item: item.id,
            });
            yield* workSource.note(
              workspace,
              item.id,
              [
                "> *This was posted by clanker-forge.*",
                "",
                "**Recovered a stale claim after a daemon restart.**",
                "",
                `Last failure: ${recoveryReason}`,
              ].join("\n"),
            );
          });
      yield* recover;
      yield* workSource.release(workspace, item.id).pipe(
        Effect.catchTag("WorkSourceError", (error) =>
          Effect.logWarning("claim release failed", {
            workspace: workspace.config.name,
            item: item.id,
            message: error.message,
          }),
        ),
      );
    });

    const recoverWorkspace = Effect.fn("Scheduler.recoverWorkspace")(function* (
      workspace: RegisteredWorkspace,
    ) {
      const observed = yield* workSource.observe(workspace);
      const owner = claimant(workspace);
      const stale = observed.filter((item) => item.claim?.by === owner);
      yield* Effect.forEach(stale, (item) => recoverStale(workspace, item), { discard: true });
    });

    const recover = Effect.fn("Scheduler.recover")(function* () {
      yield* Effect.forEach(
        registry.workspaces,
        (workspace) =>
          recoverWorkspace(workspace).pipe(
            Effect.catchTag("WorkSourceError", (error) =>
              Effect.logWarning("claim recovery skipped", {
                workspace: workspace.config.name,
                message: error.message,
              }),
            ),
          ),
        { discard: true },
      );
    });

    return { tick, drain, recover, stats: Ref.get(stateRef), config } as const;
  });

export class Scheduler extends Context.Service<Scheduler, Effect.Success<ReturnType<typeof make>>>()(
  "@clanker-forge/engine/Scheduler",
) {}

export const layer = (config: SchedulerConfig) => Layer.effect(Scheduler, make(config));
