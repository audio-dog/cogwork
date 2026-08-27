import type { SchedulerConfigUpdate, WorkspaceId } from "@cogwork/contracts";
import { byStageThenPriority as byStageThenPriorityOf } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { EligibleWork } from "./classify";
import { Executor } from "./executor";
import { runnable } from "./playbook";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { branchName, ticketSlug } from "./worktree";

export interface SchedulerConfig {
  readonly globalLimit: number;
  readonly perWorkspaceLimit: number;
  readonly dailyBudget: number;
  readonly startPaused?: boolean;
}

// Apply a partial config write, leaving any absent field at its current value.
const applyConfigUpdate = (config: SchedulerConfig, update: SchedulerConfigUpdate): SchedulerConfig => ({
  globalLimit: update.globalLimit ?? config.globalLimit,
  perWorkspaceLimit: update.perWorkspaceLimit ?? config.perWorkspaceLimit,
  dailyBudget: update.dailyBudget ?? config.dailyBudget,
});

export interface SchedulerState {
  readonly global: number;
  readonly perWorkspace: ReadonlyMap<WorkspaceId, number>;
  readonly inflight: ReadonlySet<string>;
  readonly generation: number;
  readonly acted: ReadonlySet<string>;
  readonly budgetDay: number;
  readonly budgetUsed: number;
  readonly stopping: boolean;
  readonly paused: boolean;
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
  paused: false,
};

export const seedState = (config: SchedulerConfig) =>
  config.startPaused ? { ...initialState, paused: true } : initialState;

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

const byStageThenPriority = (a: Candidate, b: Candidate) => byStageThenPriorityOf(a.work, b.work);

const fits = (candidate: Candidate, state: SchedulerState, config: SchedulerConfig) =>
  !state.stopping &&
  !state.paused &&
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
    .sort(byStageThenPriority)
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

const candidateOf = (
  workspace: RegisteredWorkspace,
  work: EligibleWork,
  config: SchedulerConfig,
): Candidate => ({
  workspace,
  work,
  workspaceLimit: workspace.workspaceLimit ?? config.perWorkspaceLimit,
  keys: keysFor(workspace, work),
});

const candidatesOf = (registry: RegistryState, snapshot: ReconcileSnapshot, config: SchedulerConfig) => {
  const byName = new Map(registry.workspaces.map((workspace) => [workspace.config.name, workspace]));
  return snapshot.workspaces.flatMap((state): ReadonlyArray<Candidate> => {
    const workspace = state.poll.status === "ok" ? byName.get(state.name) : undefined;
    if (!workspace) return [];
    return state.eligible
      .filter((work) => runnable(workspace.config, work.stage))
      .map((work) => candidateOf(workspace, work, config));
  });
};

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const worker = yield* ReconcileWorker;
    const executor = yield* Executor;
    const ledger = yield* RunLedger;
    const jobs = yield* FiberSet.make<void>();
    const stateRef = yield* Ref.make(seedState(config));
    // The limits and budget are writable at runtime (the config-write RPC), so they live in a Ref
    // rather than the closure — every tick and admit reads the current value.
    const configRef = yield* Ref.make(config);
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
      const config = yield* Ref.get(configRef);
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
      yield* Effect.forEach(planned.picks, (candidate) => FiberSet.run(jobs, runJob(candidate)), {
        discard: true,
      });
      return planned.picks.length;
    });

    const awaitIdle = FiberSet.awaitEmpty(jobs);

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

    // admit must not gate on fits(): a resume reclaims work already in flight and must always start.
    const admit = Effect.fn("Scheduler.admit")(function* (
      workspace: RegisteredWorkspace,
      work: EligibleWork,
    ) {
      const config = yield* Ref.get(configRef);
      const candidate = candidateOf(workspace, work, config);
      yield* Ref.update(stateRef, (state) => reserve(state, candidate));
      yield* FiberSet.run(jobs, runJob(candidate));
    });

    const setScheduling = Effect.fn("Scheduler.setScheduling")(function* (desired: "running" | "paused") {
      yield* Ref.update(stateRef, (state) => ({ ...state, paused: desired === "paused" }));
      return yield* Ref.get(stateRef);
    });

    const setConfig = Effect.fn("Scheduler.setConfig")(function* (update: SchedulerConfigUpdate) {
      return yield* Ref.updateAndGet(configRef, (current) => applyConfigUpdate(current, update));
    });

    return {
      tick,
      awaitIdle,
      drain,
      admit,
      setScheduling,
      setConfig,
      stats: Ref.get(stateRef),
      config: Ref.get(configRef),
    } as const;
  });

export class Scheduler extends Context.Service<Scheduler, Effect.Success<ReturnType<typeof make>>>()(
  "@cogwork/engine/scheduler",
) {}

export const layer = (config: SchedulerConfig) => Layer.effect(Scheduler, make(config));
