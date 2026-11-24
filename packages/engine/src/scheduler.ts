import { type ControlStore, type DaemonLimitUpdate, keyOf, type WorkspaceId } from "@cogwork/contracts";
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

import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { day } from "./time";
import { TriggerObservation } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { WorkflowRun, type WorkflowRunOutcome } from "./workflow-run";

const runsInFlight = Metric.gauge("cogwork_scheduler_runs_in_flight", {
  description: "Runs currently executing across all workflows.",
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

const limitUpdates = {
  "global-concurrency": (config: SchedulerConfig, value: number) => ({ ...config, globalLimit: value }),
  "per-workspace-concurrency": (config: SchedulerConfig, value: number) => ({
    ...config,
    perWorkspaceLimit: value,
  }),
  "daily-budget": (config: SchedulerConfig, value: number) => ({ ...config, dailyBudget: value }),
} satisfies Record<DaemonLimitUpdate["key"], (config: SchedulerConfig, value: number) => SchedulerConfig>;

const applyLimit = (config: SchedulerConfig, update: DaemonLimitUpdate) =>
  limitUpdates[update.key](config, update.value);

export interface SchedulerState {
  readonly global: number;
  readonly perWorkspace: ReadonlyMap<WorkspaceId, number>;
  readonly startedRuns: ReadonlyMap<string, WorkspaceId | null>;
  readonly inflight: ReadonlySet<string>;
  readonly acted: ReadonlySet<string>;
  readonly deferred: ReadonlyMap<string, number>;
  readonly budgetDay: number;
  readonly budgetUsed: number;
  readonly stopping: boolean;
  readonly paused: boolean;
}

export const initialState: SchedulerState = {
  global: 0,
  perWorkspace: new Map(),
  startedRuns: new Map(),
  inflight: new Set(),
  acted: new Set(),
  deferred: new Map(),
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

interface WorkflowCandidate {
  readonly admission: TriggerAdmission;
  readonly keys: ReadonlyArray<string>;
  readonly reservationKeys: ReadonlyArray<string>;
  readonly workspace: WorkspaceId | null;
  readonly workspaceLimit: number;
}

interface ReservationDisposition {
  readonly refundBudget: boolean;
  readonly retry: boolean;
  readonly defer: boolean;
}

const workflowRunDispositions = {
  completed: { refundBudget: false, retry: false, defer: false },
  retry: { refundBudget: false, retry: true, defer: false },
  skipped: { refundBudget: true, retry: false, defer: false },
  waiting: { refundBudget: true, retry: true, defer: true },
} satisfies Record<WorkflowRunOutcome, ReservationDisposition>;

const waitingRecheckInterval = Duration.minutes(1);

const workflowItemKeyFor = (admission: TriggerAdmission) => `workflow:${keyOf(admission.event.key)}`;

const workflowKeyFor = (admission: TriggerAdmission) =>
  JSON.stringify([
    workflowItemKeyFor(admission),
    admission.event.revision,
    admission.subscription.workflow,
    admission.subscription.trigger,
  ]);

const workflowCandidateOf = (admission: TriggerAdmission, workspaceLimit: number): WorkflowCandidate => ({
  admission,
  keys: [workflowKeyFor(admission)],
  reservationKeys: [workflowItemKeyFor(admission)],
  workspace: admission.event.workspace,
  workspaceLimit,
});

const fits = (candidate: WorkflowCandidate, state: SchedulerState, config: SchedulerConfig) => {
  const schedulerAvailable =
    !state.stopping &&
    !state.paused &&
    state.global < config.globalLimit &&
    state.budgetUsed < config.dailyBudget;
  const workspaceAvailable =
    candidate.workspace === null ||
    (state.perWorkspace.get(candidate.workspace) ?? 0) < candidate.workspaceLimit;
  const identityAvailable = candidate.keys.every((key) => !state.acted.has(key) && !state.deferred.has(key));
  const reservationAvailable = candidate.reservationKeys.every((key) => !state.inflight.has(key));
  return schedulerAvailable && workspaceAvailable && identityAvailable && reservationAvailable;
};

const bumped = (map: ReadonlyMap<WorkspaceId, number>, key: WorkspaceId, delta: number) => {
  const next = new Map(map);
  const value = (map.get(key) ?? 0) + delta;
  if (value <= 0) {
    next.delete(key);
    return next;
  }
  next.set(key, value);
  return next;
};

const workspaceLoad = (state: SchedulerState, candidate: WorkflowCandidate, delta: number) =>
  candidate.workspace === null ? state.perWorkspace : bumped(state.perWorkspace, candidate.workspace, delta);

const reserve = (state: SchedulerState, candidate: WorkflowCandidate) => ({
  ...state,
  global: state.global + 1,
  perWorkspace: workspaceLoad(state, candidate, 1),
  inflight: new Set([...state.inflight, ...candidate.reservationKeys]),
  acted: new Set([...state.acted, ...candidate.keys]),
  budgetUsed: state.budgetUsed + 1,
});

const startRun = (state: SchedulerState, candidate: WorkflowCandidate) => ({
  ...state,
  startedRuns: new Map([
    ...state.startedRuns,
    ...candidate.keys.map((key) => [key, candidate.workspace] as const),
  ]),
});

const release = (state: SchedulerState, candidate: WorkflowCandidate, retry: boolean) => ({
  ...state,
  global: Math.max(0, state.global - 1),
  perWorkspace: workspaceLoad(state, candidate, -1),
  startedRuns: new Map([...state.startedRuns].filter(([key]) => !candidate.keys.includes(key))),
  inflight: new Set([...state.inflight].filter((key) => !candidate.reservationKeys.includes(key))),
  acted: retry ? new Set([...state.acted].filter((key) => !candidate.keys.includes(key))) : state.acted,
});

const withDeferral = (state: SchedulerState, candidate: WorkflowCandidate, nowMillis: number) => {
  const retryAtMillis = nowMillis + Duration.toMillis(waitingRecheckInterval);
  return {
    ...state,
    deferred: new Map([...state.deferred, ...candidate.keys.map((key) => [key, retryAtMillis] as const)]),
  };
};

const finishReservation = (
  state: SchedulerState,
  candidate: WorkflowCandidate,
  disposition: ReservationDisposition,
  nowMillis: number,
) => {
  const released = release(state, candidate, disposition.retry);
  const refunded = disposition.refundBudget
    ? { ...released, budgetUsed: Math.max(0, released.budgetUsed - 1) }
    : released;
  return disposition.defer ? withDeferral(refunded, candidate, nowMillis) : refunded;
};

const correlationOf = ({ admission }: WorkflowCandidate) => ({
  workflow: admission.subscription.workflow,
  item: keyOf(admission.event.key),
  operation: admission.subscription.operation,
});

const utcDay = (millis: number) => Math.floor(millis / Duration.toMillis(day));

const refreshed = (
  state: SchedulerState,
  nowMillis: number,
  candidates: ReadonlyArray<WorkflowCandidate>,
) => {
  const today = utcDay(nowMillis);
  const rolledOver = state.budgetDay === today ? state : { ...state, budgetDay: today, budgetUsed: 0 };
  const live = new Set([...candidates.flatMap(({ keys }) => keys), ...rolledOver.inflight]);
  return {
    ...rolledOver,
    acted: new Set([...rolledOver.acted].filter((key) => live.has(key))),
    deferred: new Map(
      [...rolledOver.deferred].filter(([key, retryAtMillis]) => live.has(key) && retryAtMillis > nowMillis),
    ),
  };
};

const updateStateMetrics = (state: SchedulerState) =>
  Effect.all(
    [Metric.update(runsInFlight, state.startedRuns.size), Metric.update(budgetUsed, state.budgetUsed)],
    {
      discard: true,
    },
  );

const jobOutcome = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return "success";
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "failure";
};

const recordJobOutcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Metric.update(Metric.withAttributes(jobOutcomes, { outcome: jobOutcome(exit) }), 1);

export const make = (config: SchedulerConfig) =>
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const ledger = yield* RunLedger;
    const triggerObservation = yield* TriggerObservation;
    const workflowRun = yield* WorkflowRun;
    const jobs = yield* FiberSet.make<void>();
    const stateRef = yield* Ref.make(seedState(config));
    const stateMetricsGate = Semaphore.makeUnsafe(1);
    const configRef = yield* Ref.make(config);
    const startedAtMillis = yield* Clock.currentTimeMillis;

    const updateState = (next: (state: SchedulerState) => SchedulerState) =>
      stateMetricsGate.withPermit(Ref.updateAndGet(stateRef, next).pipe(Effect.flatMap(updateStateMetrics)));

    const runWorkflow = (candidate: WorkflowCandidate) =>
      Ref.make<ReservationDisposition>({ refundBudget: false, retry: true, defer: false }).pipe(
        Effect.flatMap((dispositionRef) =>
          workflowRun
            .execute(
              candidate.admission,
              updateState((state) => startRun(state, candidate)),
            )
            .pipe(
              Effect.map((outcome) => workflowRunDispositions[outcome]),
              Effect.tap((disposition) => Ref.set(dispositionRef, disposition)),
              Effect.asVoid,
              Effect.onExit(recordJobOutcome),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.logWarning("scheduled job crashed", cause),
              ),
              Effect.ensuring(
                Effect.all([Ref.get(dispositionRef), Clock.currentTimeMillis]).pipe(
                  Effect.flatMap(([disposition, nowMillis]) =>
                    updateState((state) => finishReservation(state, candidate, disposition, nowMillis)),
                  ),
                ),
              ),
              Effect.annotateLogs(correlationOf(candidate)),
            ),
        ),
      );

    const isWaiting = Effect.fn("Scheduler.isWaiting")((candidate: WorkflowCandidate) =>
      workflowRun.isWaiting(candidate.admission).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("readiness check failed; the candidate counts as ready", cause).pipe(
              Effect.map(() => false),
            ),
        ),
      ),
    );

    const reserveIfFits = Effect.fn("Scheduler.reserveIfFits")(
      (candidate: WorkflowCandidate, config: SchedulerConfig) =>
        stateMetricsGate.withPermit(
          Ref.modify(stateRef, (state) => {
            if (!fits(candidate, state, config)) return [{ reserved: false, state }, state];
            const next = reserve(state, candidate);
            return [{ reserved: true, state: next }, next];
          }).pipe(
            Effect.tap(({ state }) => updateStateMetrics(state)),
            Effect.map(({ reserved }) => reserved),
          ),
        ),
    );

    const start = Effect.fn("Scheduler.start")(function* (
      candidate: WorkflowCandidate,
      config: SchedulerConfig,
    ) {
      if (!(yield* reserveIfFits(candidate, config))) return false;
      yield* FiberSet.run(jobs, runWorkflow(candidate));
      return true;
    }, Effect.uninterruptible);

    const offer = Effect.fn("Scheduler.offer")(function* (
      candidate: WorkflowCandidate,
      config: SchedulerConfig,
    ) {
      if (!fits(candidate, yield* Ref.get(stateRef), config)) return false;
      if (yield* isWaiting(candidate)) {
        const checkedAtMillis = yield* Clock.currentTimeMillis;
        yield* Ref.update(stateRef, (state) => withDeferral(state, candidate, checkedAtMillis));
        return false;
      }
      return yield* start(candidate, config);
    });

    const tick = Effect.fn("Scheduler.tick")(function* () {
      const config = yield* Ref.get(configRef);
      yield* workflowRun.refreshReviewPlans();
      const registryState = yield* registry.state;
      const workspaceLimits = new Map(
        registryState.workspaces.map(({ config: workspace, workspaceLimit }) => [
          workspace.id,
          workspaceLimit ?? config.perWorkspaceLimit,
        ]),
      );
      const candidates = (yield* triggerObservation.eligible).map((admission) =>
        workflowCandidateOf(
          admission,
          admission.event.workspace === null
            ? config.perWorkspaceLimit
            : (workspaceLimits.get(admission.event.workspace) ?? config.perWorkspaceLimit),
        ),
      );
      const nowMillis = yield* Clock.currentTimeMillis;
      yield* stateMetricsGate.withPermit(
        Ref.updateAndGet(stateRef, (state) => refreshed(state, nowMillis, candidates)).pipe(
          Effect.flatMap(updateStateMetrics),
        ),
      );
      const started = yield* Effect.forEach(candidates, (candidate) =>
        offer(candidate, config).pipe(Effect.annotateLogs(correlationOf(candidate))),
      );
      const picks = started.filter(Boolean).length;
      const state = yield* Ref.get(stateRef);
      const budgetExhausted =
        !state.stopping &&
        !state.paused &&
        picks === 0 &&
        candidates.length > 0 &&
        state.budgetUsed >= config.dailyBudget;
      if (budgetExhausted) yield* Metric.update(budgetExhaustedTicks, 1);
      return picks;
    }, Effect.trackDuration(schedulerTickDuration));

    const drain = Effect.fn("Scheduler.drain")(function* (options: DrainOptions) {
      yield* Ref.update(stateRef, (state) => ({ ...state, stopping: true }));
      const inFlight = yield* FiberSet.size(jobs);
      yield* Effect.raceAll([FiberSet.awaitEmpty(jobs), Effect.sleep(options.graceMillis), options.abort]);
      const interrupted = yield* FiberSet.size(jobs);
      const endedAtMillis = yield* Clock.currentTimeMillis;
      yield* ledger.interruptRunning(startedAtMillis, endedAtMillis);
      yield* FiberSet.clear(jobs);
      return { inFlight, interrupted } satisfies DrainOutcome;
    });

    const setScheduling = Effect.fn("Scheduler.setScheduling")((desired: "running" | "paused") =>
      Ref.update(stateRef, (state) => ({ ...state, paused: desired === "paused" })),
    );

    const setLimit = Effect.fn("Scheduler.setLimit")((update: DaemonLimitUpdate) =>
      Ref.updateAndGet(configRef, (current) => applyLimit(current, update)),
    );

    return {
      tick,
      awaitIdle: FiberSet.awaitEmpty(jobs),
      drain,
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
