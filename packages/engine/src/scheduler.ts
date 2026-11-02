import {
  byStageThenPriority as byStageThenPriorityOf,
  type ControlStore,
  type DaemonLimitUpdate,
  keyOf,
  PollState,
  type RunPlanObservation,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { EligibleWork } from "./classify";
import { Executor } from "./executor";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { day } from "./time";
import { type TriggerAdmission, TriggerObservation } from "./trigger-observation";
import { WorkflowRun, type WorkflowRunOutcome } from "./workflow-run";
import { branchName, ticketSlug } from "./worktree";

const runsInFlight = Metric.gauge("cogwork_scheduler_runs_in_flight", {
  description: "Runs currently executing across all workspaces.",
});
const budgetUsed = Metric.gauge("cogwork_scheduler_budget_used", {
  description: "Runs charged against the current UTC day's budget.",
});
const budgetExhaustedTicks = Metric.counter("cogwork_scheduler_budget_exhausted_ticks_total", {
  description: "Scheduler ticks that found eligible work after the daily budget was exhausted.",
});
const jobOutcomes = Metric.counter("cogwork_scheduler_job_outcomes_total", {
  description: "Scheduled jobs completed by outcome.",
});
export const schedulerTickDuration = Metric.timer("cogwork_scheduler_tick_duration", {
  description: "Time to plan and dispatch one scheduler tick.",
});

export interface SchedulerConfig {
  readonly globalLimit: number;
  readonly perWorkspaceLimit: number;
  readonly dailyBudget: number;
  readonly startPaused?: boolean;
}

export const configFromControlStore = (controlStore: ControlStore): SchedulerConfig => ({
  globalLimit: controlStore.daemonLimits.globalConcurrency,
  perWorkspaceLimit: controlStore.daemonLimits.perWorkspaceConcurrency,
  dailyBudget: controlStore.daemonLimits.dailyBudget,
  startPaused: true,
});

const applyLimit = (config: SchedulerConfig, update: DaemonLimitUpdate): SchedulerConfig => {
  if (update.key === "global-concurrency") return { ...config, globalLimit: update.value };
  if (update.key === "per-workspace-concurrency") return { ...config, perWorkspaceLimit: update.value };
  return { ...config, dailyBudget: update.value };
};

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

const utcDay = (millis: number) => Math.floor(millis / Duration.toMillis(day));

export interface Candidate {
  readonly workspace: RegisteredWorkspace;
  readonly work: EligibleWork;
  readonly workspaceLimit: number;
  readonly keys: ReadonlyArray<string>;
  readonly observation: RunPlanObservation;
}

interface WorkflowCandidate {
  readonly admission: TriggerAdmission;
  readonly keys: ReadonlyArray<string>;
  readonly reservationKeys: ReadonlyArray<string>;
}

type Schedulable = Candidate | WorkflowCandidate;

interface ReservationDisposition {
  readonly refundBudget: boolean;
  readonly retry: boolean;
}

const WORKFLOW_RUN_DISPOSITIONS = {
  completed: { refundBudget: false, retry: false },
  retry: { refundBudget: false, retry: true },
  skipped: { refundBudget: true, retry: false },
} satisfies Record<WorkflowRunOutcome, ReservationDisposition>;

const isWorkflowCandidate = (candidate: Schedulable): candidate is WorkflowCandidate =>
  "admission" in candidate;

const workflowItemKeyFor = (admission: TriggerAdmission) => `workflow:${keyOf(admission.event.key)}`;

const workflowKeyFor = (admission: TriggerAdmission) =>
  JSON.stringify([
    workflowItemKeyFor(admission),
    admission.event.revision,
    admission.subscription.workflow,
    admission.subscription.trigger,
  ]);

const workflowCandidateOf = (admission: TriggerAdmission): WorkflowCandidate => ({
  admission,
  keys: [workflowKeyFor(admission)],
  reservationKeys: [workflowItemKeyFor(admission)],
});

const reservationKeysOf = (candidate: Schedulable) =>
  isWorkflowCandidate(candidate) ? candidate.reservationKeys : candidate.keys;

const workspaceReservation = (candidate: Schedulable) =>
  isWorkflowCandidate(candidate)
    ? null
    : { workspace: candidate.workspace.config.name, limit: candidate.workspaceLimit };

const byStageThenPriority = (a: Candidate, b: Candidate) => byStageThenPriorityOf(a.work, b.work);

const fits = (candidate: Schedulable, state: SchedulerState, config: SchedulerConfig) => {
  const reservation = workspaceReservation(candidate);
  const schedulerAvailable =
    !state.stopping &&
    !state.paused &&
    state.global < config.globalLimit &&
    state.budgetUsed < config.dailyBudget;
  const workspaceAvailable =
    reservation === null || (state.perWorkspace.get(reservation.workspace) ?? 0) < reservation.limit;
  const identityAvailable = candidate.keys.every((key) => !state.acted.has(key));
  const reservationAvailable = reservationKeysOf(candidate).every((key) => !state.inflight.has(key));
  return schedulerAvailable && workspaceAvailable && identityAvailable && reservationAvailable;
};

const bumped = (map: ReadonlyMap<WorkspaceId, number>, key: WorkspaceId, delta: number) => {
  const next = new Map(map);
  const value = (map.get(key) ?? 0) + delta;
  if (value <= 0) next.delete(key);
  else next.set(key, value);
  return next;
};

const reserve = (state: SchedulerState, candidate: Schedulable) => {
  const reservation = workspaceReservation(candidate);
  return {
    ...state,
    global: state.global + 1,
    perWorkspace:
      reservation === null ? state.perWorkspace : bumped(state.perWorkspace, reservation.workspace, 1),
    inflight: new Set([...state.inflight, ...reservationKeysOf(candidate)]),
    acted: new Set([...state.acted, ...candidate.keys]),
    budgetUsed: state.budgetUsed + 1,
  };
};

const release = (state: SchedulerState, candidate: Schedulable, retry: boolean) => {
  const reservation = workspaceReservation(candidate);
  const acted =
    isWorkflowCandidate(candidate) && retry
      ? new Set([...state.acted].filter((key) => !candidate.keys.includes(key)))
      : state.acted;
  return {
    ...state,
    global: Math.max(0, state.global - 1),
    perWorkspace:
      reservation === null ? state.perWorkspace : bumped(state.perWorkspace, reservation.workspace, -1),
    inflight: new Set([...state.inflight].filter((key) => !reservationKeysOf(candidate).includes(key))),
    acted,
  };
};

const refundBudget = (state: SchedulerState) => ({
  ...state,
  budgetUsed: Math.max(0, state.budgetUsed - 1),
});

const finishReservation = (
  state: SchedulerState,
  candidate: Schedulable,
  disposition: ReservationDisposition,
) => {
  const released = release(state, candidate, disposition.retry);
  return disposition.refundBudget ? refundBudget(released) : released;
};

const rolledOver = (state: SchedulerState, day: number) =>
  state.budgetDay === day ? state : { ...state, budgetDay: day, budgetUsed: 0 };

const liveKeys = (state: SchedulerState, candidates: ReadonlyArray<Schedulable>) =>
  new Set([...candidates.flatMap((candidate) => candidate.keys), ...state.inflight]);

const atGeneration = (state: SchedulerState, generation: number, candidates: ReadonlyArray<Schedulable>) => {
  const workflowKeys = new Set(candidates.filter(isWorkflowCandidate).flatMap((candidate) => candidate.keys));
  const carried =
    state.generation === generation
      ? state.acted
      : new Set([...state.acted].filter((key) => workflowKeys.has(key)));
  const live = liveKeys(state, candidates);
  return { ...state, generation, acted: new Set([...carried].filter((key) => live.has(key))) };
};

export interface TickStamp {
  readonly day: number;
  readonly generation: number;
}

const refreshed = (state: SchedulerState, stamp: TickStamp, candidates: ReadonlyArray<Schedulable>) =>
  atGeneration(rolledOver(state, stamp.day), stamp.generation, candidates);

const updateStateMetrics = (state: SchedulerState) =>
  Effect.all([Metric.update(runsInFlight, state.global), Metric.update(budgetUsed, state.budgetUsed)], {
    discard: true,
  });

const jobOutcome = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return "success";
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupt";
  return "failure";
};

const recordJobOutcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Metric.update(Metric.withAttributes(jobOutcomes, { outcome: jobOutcome(exit) }), 1);

const isBudgetExhaustedTick = <A extends Schedulable>(
  planned: { readonly state: SchedulerState; readonly picks: ReadonlyArray<A> },
  candidates: ReadonlyArray<A>,
  config: SchedulerConfig,
) =>
  !planned.state.stopping &&
  !planned.state.paused &&
  planned.picks.length === 0 &&
  candidates.length > 0 &&
  planned.state.budgetUsed >= config.dailyBudget;

export interface Plan {
  readonly state: SchedulerState;
  readonly picks: ReadonlyArray<Candidate>;
}

const planCandidates = <A extends Schedulable>(
  candidates: ReadonlyArray<A>,
  state: SchedulerState,
  config: SchedulerConfig,
  stamp: TickStamp,
) =>
  candidates.reduce<{ readonly state: SchedulerState; readonly picks: ReadonlyArray<A> }>(
    (acc, candidate) =>
      fits(candidate, acc.state, config)
        ? { state: reserve(acc.state, candidate), picks: [...acc.picks, candidate] }
        : acc,
    { state: refreshed(state, stamp, candidates), picks: [] },
  );

export const plan = (
  candidates: ReadonlyArray<Candidate>,
  state: SchedulerState,
  config: SchedulerConfig,
  stamp: TickStamp,
) => planCandidates([...candidates].sort(byStageThenPriority), state, config, stamp);

const ticketKeyFor = (workspace: RegisteredWorkspace, itemId: WorkItemId) =>
  `${workspace.config.name}:ticket:${ticketSlug(itemId)}`;

const keysFor = (workspace: RegisteredWorkspace, work: EligibleWork) => {
  const name = workspace.config.name;
  const branch = branchName({ id: work.id, title: work.title });
  return [ticketKeyFor(workspace, work.id), `${name}:branch:${branch}`];
};

const candidateOf = (
  workspace: RegisteredWorkspace,
  work: EligibleWork,
  config: SchedulerConfig,
  observation: RunPlanObservation,
): Candidate => ({
  workspace,
  work,
  workspaceLimit: workspace.workspaceLimit ?? config.perWorkspaceLimit,
  keys: keysFor(workspace, work),
  observation,
});

const candidatesOf = (registry: RegistryState, snapshot: ReconcileSnapshot, config: SchedulerConfig) => {
  const byName = new Map(registry.workspaces.map((workspace) => [workspace.config.name, workspace]));
  const observation = {
    generation: snapshot.generation,
    observedAtMillis: snapshot.observedAtMillis,
  };
  return snapshot.workspaces.flatMap((state): ReadonlyArray<Candidate> => {
    const workspace = PollState.guards.ok(state.poll) ? byName.get(state.name) : undefined;
    if (!workspace) return [];
    return state.eligible.map((work) => candidateOf(workspace, work, config, observation));
  });
};

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const worker = yield* ReconcileWorker;
    const executor = yield* Executor;
    const ledger = yield* RunLedger;
    const triggerObservation = yield* TriggerObservation;
    const workflowRun = yield* WorkflowRun;
    const jobs = yield* FiberSet.make<void>();
    const stateRef = yield* Ref.make(seedState(config));
    const stateMetricsGate = Semaphore.makeUnsafe(1);
    const configRef = yield* Ref.make(config);
    const startedAtMillis = yield* Clock.currentTimeMillis;

    const runReserved = <E, R>(
      candidate: Schedulable,
      correlation: Readonly<Record<string, string>>,
      execute: Effect.Effect<ReservationDisposition, E, R>,
    ) => {
      const failedDisposition: ReservationDisposition = {
        refundBudget: false,
        retry: isWorkflowCandidate(candidate),
      };
      return Ref.make(failedDisposition).pipe(
        Effect.flatMap((dispositionRef) =>
          execute.pipe(
            Effect.tap((disposition) => Ref.set(dispositionRef, disposition)),
            Effect.asVoid,
            Effect.onExit(recordJobOutcome),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.logWarning("scheduled job crashed", cause),
            ),
            Effect.ensuring(
              stateMetricsGate.withPermit(
                Ref.get(dispositionRef).pipe(
                  Effect.flatMap((disposition) =>
                    Ref.updateAndGet(stateRef, (state) => finishReservation(state, candidate, disposition)),
                  ),
                  Effect.flatMap(updateStateMetrics),
                ),
              ),
            ),
            Effect.annotateLogs(correlation),
            Effect.annotateSpans(correlation),
          ),
        ),
      );
    };

    const runJob = (candidate: Candidate) =>
      runReserved(
        candidate,
        {
          workspace: candidate.workspace.config.name,
          item: candidate.work.id,
          stage: candidate.work.stage,
        },
        executor
          .execute(candidate.workspace, candidate.work, candidate.observation)
          .pipe(Effect.map((started) => ({ refundBudget: !started, retry: false }))),
      );

    const runWorkflow = (candidate: WorkflowCandidate) =>
      runReserved(
        candidate,
        {
          workflow: candidate.admission.subscription.workflow,
          item: keyOf(candidate.admission.event.key),
          operation: candidate.admission.subscription.operation,
        },
        workflowRun
          .execute(candidate.admission)
          .pipe(Effect.map((outcome) => WORKFLOW_RUN_DISPOSITIONS[outcome])),
      );

    const dispatch = (candidate: Schedulable) => {
      if (isWorkflowCandidate(candidate)) {
        return FiberSet.run(jobs, runWorkflow(candidate)).pipe(Effect.asVoid);
      }
      return FiberSet.run(jobs, runJob(candidate)).pipe(Effect.asVoid);
    };

    const tick = Effect.fn("Scheduler.tick")(function* () {
      const config = yield* Ref.get(configRef);
      const snapshot = yield* worker.snapshot;
      const candidates = candidatesOf(yield* registry.state, snapshot, config);
      yield* workflowRun.refreshReviewPlans();
      const workflowCandidates = (yield* triggerObservation.eligible).map(workflowCandidateOf);
      const schedulable = [...candidates.sort(byStageThenPriority), ...workflowCandidates];
      const day = utcDay(yield* Clock.currentTimeMillis);
      const planned = yield* stateMetricsGate.withPermit(
        Ref.modify(stateRef, (state) => {
          const next = planCandidates(schedulable, state, config, {
            day,
            generation: snapshot.generation,
          });
          return [next, next.state];
        }).pipe(Effect.tap((planned) => updateStateMetrics(planned.state))),
      );
      if (isBudgetExhaustedTick(planned, schedulable, config)) {
        yield* Metric.update(budgetExhaustedTicks, 1);
      }
      if (planned.picks.length > 0) {
        yield* Effect.logInfo("scheduled jobs", {
          picked: planned.picks.map((candidate) =>
            isWorkflowCandidate(candidate)
              ? {
                  workflow: candidate.admission.subscription.workflow,
                  item: keyOf(candidate.admission.event.key),
                  operation: candidate.admission.subscription.operation,
                }
              : {
                  workspace: candidate.workspace.config.name,
                  item: candidate.work.id,
                  stage: candidate.work.stage,
                },
          ),
          generation: snapshot.generation,
          inFlight: planned.state.global,
          budgetUsed: planned.state.budgetUsed,
        });
      }
      yield* Effect.forEach(planned.picks, dispatch, { discard: true });
      return planned.picks.length;
    }, Effect.trackDuration(schedulerTickDuration));

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
      observation: RunPlanObservation,
    ) {
      const config = yield* Ref.get(configRef);
      const candidate = candidateOf(workspace, work, config, observation);
      yield* stateMetricsGate.withPermit(
        Ref.updateAndGet(stateRef, (state) => reserve(state, candidate)).pipe(
          Effect.flatMap(updateStateMetrics),
        ),
      );
      yield* FiberSet.run(jobs, runJob(candidate));
    });

    const isInFlight = Effect.fn("Scheduler.isInFlight")(function* (
      workspace: RegisteredWorkspace,
      itemId: WorkItemId,
    ) {
      return (yield* Ref.get(stateRef)).inflight.has(ticketKeyFor(workspace, itemId));
    });

    const setScheduling = Effect.fn("Scheduler.setScheduling")(function* (desired: "running" | "paused") {
      yield* Ref.update(stateRef, (state) => ({ ...state, paused: desired === "paused" }));
      return yield* Ref.get(stateRef);
    });

    const setLimit = Effect.fn("Scheduler.setLimit")(function* (update: DaemonLimitUpdate) {
      return yield* Ref.updateAndGet(configRef, (current) => applyLimit(current, update));
    });

    return {
      tick,
      awaitIdle,
      drain,
      admit,
      isInFlight,
      setScheduling,
      setLimit,
      stats: Ref.get(stateRef),
      config: Ref.get(configRef),
    } as const;
  });

export class Scheduler extends Context.Service<Scheduler, Effect.Success<ReturnType<typeof make>>>()(
  "@cogwork/engine/scheduler",
) {}

export const layer = (config: SchedulerConfig) => Layer.effect(Scheduler, make(config));
