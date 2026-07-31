import type { WorkspaceId } from "@clanker-forge/contracts";
import { stagePriority } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { EligibleWork } from "./classify";
import { claimant, Executor } from "./Executor";
import { runnable } from "./Playbook";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker } from "./Reconcile";
import { WorkspaceRegistry } from "./Registry";
import { type ObservedItem, WorkSource } from "./WorkSource";
import { branchName, ticketSlug } from "./Worktree";

export interface SchedulerConfig {
  readonly globalLimit: number;
  readonly dailyBudget: number;
}

export interface SchedulerState {
  readonly global: number;
  readonly perWorkspace: ReadonlyMap<WorkspaceId, number>;
  readonly inflight: ReadonlySet<string>;
  readonly budgetDay: number;
  readonly budgetUsed: number;
}

export const initialState: SchedulerState = {
  global: 0,
  perWorkspace: new Map(),
  inflight: new Set(),
  budgetDay: -1,
  budgetUsed: 0,
};

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
  state.global < config.globalLimit &&
  (state.perWorkspace.get(candidate.workspace.config.name) ?? 0) < candidate.workspaceLimit &&
  state.budgetUsed < config.dailyBudget &&
  candidate.keys.every((key) => !state.inflight.has(key));

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

export interface Plan {
  readonly state: SchedulerState;
  readonly picks: ReadonlyArray<Candidate>;
}

export const plan = (
  candidates: ReadonlyArray<Candidate>,
  state: SchedulerState,
  config: SchedulerConfig,
  day: number,
) =>
  [...candidates]
    .sort(byPriority)
    .reduce<Plan>(
      (acc, candidate) =>
        fits(candidate, acc.state, config)
          ? { state: reserve(acc.state, candidate), picks: [...acc.picks, candidate] }
          : acc,
      { state: rolledOver(state, day), picks: [] },
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

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const worker = yield* ReconcileWorker;
    const executor = yield* Executor;
    const workSource = yield* WorkSource;
    const scope = yield* Effect.scope;
    const stateRef = yield* Ref.make(initialState);

    const runJob = (candidate: Candidate) =>
      executor.execute(candidate.workspace, candidate.work).pipe(
        Effect.flatMap((started) => (started ? Effect.void : Ref.update(stateRef, refundBudget))),
        Effect.catchCause((cause) =>
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
        const next = plan(candidates, state, config, day);
        return [next, next.state];
      });
      if (planned.picks.length > 0) {
        yield* Effect.logInfo("scheduled jobs", {
          picked: planned.picks.map((c) => ({
            workspace: c.workspace.config.name,
            item: c.work.id,
            stage: c.work.stage,
          })),
          inFlight: planned.state.global,
          budgetUsed: planned.state.budgetUsed,
        });
      }
      return yield* Effect.forEach(planned.picks, (candidate) => Effect.forkIn(runJob(candidate), scope));
    });

    const releaseStale = Effect.fn("Scheduler.releaseStale")(function* (
      workspace: RegisteredWorkspace,
      item: ObservedItem,
    ) {
      yield* workSource.release(workspace, item.id).pipe(
        Effect.tap(() =>
          Effect.logInfo("recovered stale claim", { workspace: workspace.config.name, item: item.id }),
        ),
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
      yield* Effect.forEach(stale, (item) => releaseStale(workspace, item), { discard: true });
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

    return { tick, recover, stats: Ref.get(stateRef), config } as const;
  });

export class Scheduler extends Context.Service<Scheduler, Effect.Success<ReturnType<typeof make>>>()(
  "@clanker-forge/engine/Scheduler",
) {}

export const layer = (config: SchedulerConfig) => Layer.effect(Scheduler, make(config));
