import type { LifecycleStage, SessionId, WorkspaceId } from "@clanker-forge/contracts";
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
  maxCrashesPerItem,
  observedStage,
} from "./classify";
import { attachCommand, type HandoffCause, handoffComment, recoveryReason } from "./comments";
import { claimant, Executor } from "./executor";
import { followUpContext } from "./follow-up";
import { observeWorkspace } from "./observe";
import { runnable } from "./playbook";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { SourceControlProvider } from "./source-control";
import { type ObservedItem, WorkSource } from "./work-source";
import { branchName, checkoutPathFor, ticketSlug } from "./worktree";

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

const eligibleFromObserved = (item: ObservedItem, stage: LifecycleStage): EligibleWork => {
  const priorFailures = consecutiveFailures(item, stage);
  const followUp = stage === "follow-up" && item.pr ? followUpContext(item.pr) : undefined;
  return { id: item.id, title: item.title, stage, priorFailures, ...(followUp ? { followUp } : {}) };
};

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const worker = yield* ReconcileWorker;
    const executor = yield* Executor;
    const workSource = yield* WorkSource;
    const provider = yield* SourceControlProvider;
    const observe = observeWorkspace(workSource, provider);
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

    const escalateToHuman = Effect.fn("Scheduler.escalateToHuman")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      cause: HandoffCause,
      session: string | null | undefined,
    ) {
      const role = handoffRoleFor(stage);
      const checkout = checkoutForStage(workspace, item, stage);
      const resume = session ? attachCommand(checkout, session) : undefined;
      yield* workSource.setRoles(workspace, item.id, {
        remove: role ? [role] : [],
        add: ["ready-for-human"],
      });
      yield* workSource.note(workspace, item.id, handoffComment(stage, cause, recoveryReason, resume));
    });

    const handoffRecovery = (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      attempts: number,
      session: string | null | undefined,
    ) => escalateToHuman(workspace, item, stage, { kind: "max-attempts", attempts }, session);

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

    const releaseClaim = Effect.fn("Scheduler.releaseClaim")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
    ) {
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

    const recoverStale = Effect.fn("Scheduler.recoverStale")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage | null,
      session: string | null | undefined,
    ) {
      const endedAtMillis = yield* Clock.currentTimeMillis;
      yield* ledger.closeRunning(workspace.config.name, item.id, endedAtMillis);
      const recover = stage
        ? recordRecovery(workspace, item, stage, endedAtMillis, session)
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
      yield* releaseClaim(workspace, item);
    });

    const reschedule = Effect.fn("Scheduler.reschedule")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      reason: "interrupted" | "crashed",
      session: SessionId | null,
    ) {
      const observed = eligibleFromObserved(item, stage);
      const work: EligibleWork = session ? { ...observed, resume: { session, reason } } : observed;
      const candidate: Candidate = {
        workspace,
        work,
        workspaceLimit: workspace.config.concurrency ?? config.globalLimit,
        keys: keysFor(workspace, work),
      };
      yield* Effect.logInfo("rescheduled resumable run", {
        workspace: workspace.config.name,
        item: item.id,
        stage,
        reason,
      });
      yield* Ref.update(stateRef, (state) => reserve(state, candidate));
      yield* FiberSet.run(jobs, runJob(candidate));
    });

    const handoffCrashLoop = Effect.fn("Scheduler.handoffCrashLoop")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      crashes: number,
      session: string | null | undefined,
    ) {
      yield* Effect.logWarning("crash loop capped", {
        workspace: workspace.config.name,
        item: item.id,
        stage,
        crashes,
      });
      yield* escalateToHuman(workspace, item, stage, { kind: "crash-loop", crashes }, session);
      yield* releaseClaim(workspace, item);
    });

    const recoverCrashed = Effect.fn("Scheduler.recoverCrashed")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
      stage: LifecycleStage,
      session: SessionId | null,
    ) {
      const endedAtMillis = yield* Clock.currentTimeMillis;
      yield* ledger.crashRunning(workspace.config.name, item.id, endedAtMillis);
      const crashes = yield* ledger.consecutiveCrashes(workspace.config.name, item.id);
      if (crashes < maxCrashesPerItem) {
        return yield* reschedule(workspace, item, stage, "crashed", session);
      }
      yield* handoffCrashLoop(workspace, item, stage, crashes, session);
    });

    const recoverItem = Effect.fn("Scheduler.recoverItem")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
    ) {
      const last = yield* ledger.latestRunForItem(workspace.config.name, item.id);
      const stage = observedStage(item);
      if (stage && last?.status === "interrupted") {
        return yield* reschedule(workspace, item, stage, "interrupted", last.session);
      }
      if (stage && last?.status === "running") {
        return yield* recoverCrashed(workspace, item, stage, last.session);
      }
      yield* recoverStale(workspace, item, stage, last?.session);
    });

    const recoverWorkspace = Effect.fn("Scheduler.recoverWorkspace")(function* (
      workspace: RegisteredWorkspace,
    ) {
      const observed = yield* observe(workspace);
      const owner = claimant(workspace);
      const claimedByUs = observed.filter((item) => item.claim?.by === owner);
      yield* Effect.forEach(claimedByUs, (item) => recoverItem(workspace, item), { discard: true });
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
  "@clanker-forge/engine/scheduler",
) {}

export const layer = (config: SchedulerConfig) => Layer.effect(Scheduler, make(config));
