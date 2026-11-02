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
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { day } from "./time";
import { type TriggerAdmission, TriggerObservation } from "./trigger-observation";
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
  readonly inflight: ReadonlySet<string>;
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
}

const workflowRunDispositions = {
  completed: { refundBudget: false, retry: false },
  retry: { refundBudget: false, retry: true },
  skipped: { refundBudget: true, retry: false },
} satisfies Record<WorkflowRunOutcome, ReservationDisposition>;

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
  const identityAvailable = candidate.keys.every((key) => !state.acted.has(key));
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

const reserve = (state: SchedulerState, candidate: WorkflowCandidate) => ({
  ...state,
  global: state.global + 1,
  perWorkspace:
    candidate.workspace === null ? state.perWorkspace : bumped(state.perWorkspace, candidate.workspace, 1),
  inflight: new Set([...state.inflight, ...candidate.reservationKeys]),
  acted: new Set([...state.acted, ...candidate.keys]),
  budgetUsed: state.budgetUsed + 1,
});

const release = (state: SchedulerState, candidate: WorkflowCandidate, retry: boolean) => ({
  ...state,
  global: Math.max(0, state.global - 1),
  perWorkspace:
    candidate.workspace === null ? state.perWorkspace : bumped(state.perWorkspace, candidate.workspace, -1),
  inflight: new Set([...state.inflight].filter((key) => !candidate.reservationKeys.includes(key))),
  acted: retry ? new Set([...state.acted].filter((key) => !candidate.keys.includes(key))) : state.acted,
});

const finishReservation = (
  state: SchedulerState,
  candidate: WorkflowCandidate,
  disposition: ReservationDisposition,
) => {
  const released = release(state, candidate, disposition.retry);
  return disposition.refundBudget
    ? { ...released, budgetUsed: Math.max(0, released.budgetUsed - 1) }
    : released;
};

const utcDay = (millis: number) => Math.floor(millis / Duration.toMillis(day));

const refreshed = (state: SchedulerState, today: number, candidates: ReadonlyArray<WorkflowCandidate>) => {
  const rolledOver = state.budgetDay === today ? state : { ...state, budgetDay: today, budgetUsed: 0 };
  const live = new Set([...candidates.flatMap(({ keys }) => keys), ...rolledOver.inflight]);
  return { ...rolledOver, acted: new Set([...rolledOver.acted].filter((key) => live.has(key))) };
};

const planCandidates = (
  candidates: ReadonlyArray<WorkflowCandidate>,
  state: SchedulerState,
  config: SchedulerConfig,
  today: number,
) =>
  candidates.reduce<{ readonly state: SchedulerState; readonly picks: ReadonlyArray<WorkflowCandidate> }>(
    (planned, candidate) =>
      fits(candidate, planned.state, config)
        ? { state: reserve(planned.state, candidate), picks: [...planned.picks, candidate] }
        : planned,
    { state: refreshed(state, today, candidates), picks: [] },
  );

const updateStateMetrics = (state: SchedulerState) =>
  Effect.all([Metric.update(runsInFlight, state.global), Metric.update(budgetUsed, state.budgetUsed)], {
    discard: true,
  });

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

    const runWorkflow = (candidate: WorkflowCandidate) =>
      Ref.make<ReservationDisposition>({ refundBudget: false, retry: true }).pipe(
        Effect.flatMap((dispositionRef) =>
          workflowRun.execute(candidate.admission).pipe(
            Effect.map((outcome) => workflowRunDispositions[outcome]),
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
            Effect.annotateLogs({
              workflow: candidate.admission.subscription.workflow,
              item: keyOf(candidate.admission.event.key),
              operation: candidate.admission.subscription.operation,
            }),
          ),
        ),
      );

    const tick = Effect.fn("Scheduler.tick")(function* () {
      const config = yield* Ref.get(configRef);
      const registryState = yield* registry.state;
      const workspaceLimits = new Map(
        registryState.workspaces.map(({ config: workspace, workspaceLimit }) => [
          workspace.name,
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
      const today = utcDay(yield* Clock.currentTimeMillis);
      const planned = yield* stateMetricsGate.withPermit(
        Ref.modify(stateRef, (state) => {
          const next = planCandidates(candidates, state, config, today);
          return [next, next.state];
        }).pipe(Effect.tap(({ state }) => updateStateMetrics(state))),
      );
      const budgetExhausted =
        !planned.state.stopping &&
        !planned.state.paused &&
        planned.picks.length === 0 &&
        candidates.length > 0 &&
        planned.state.budgetUsed >= config.dailyBudget;
      if (budgetExhausted) yield* Metric.update(budgetExhaustedTicks, 1);
      yield* Effect.forEach(planned.picks, (candidate) => FiberSet.run(jobs, runWorkflow(candidate)), {
        discard: true,
      });
      return planned.picks.length;
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
