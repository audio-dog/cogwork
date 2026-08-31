import type {
  RunEvent,
  RunId,
  RunPlan,
  RunRecord,
  RunSummary,
  Session,
  SessionId,
  TokenUsage,
} from "@cogwork/contracts";
import {
  RunPlan as RunPlanSchema,
  sessionHandle,
  sessionResumable,
  workItemCandidates,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { DaemonEventBus, type DaemonEventBusService } from "./daemon-event-bus";
import { freezeRunPlan } from "./run-plan";

export interface RunUpdate {
  readonly status: RunSummary["status"];
  readonly usage: TokenUsage | null;
  readonly endedAtMillis: number;
}

export class RunLedgerError extends Schema.TaggedError<RunLedgerError>()("RunLedgerError", {
  operation: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

const runLedgerError = (operation: string, message: string) =>
  Effect.fail(RunLedgerError.make({ operation, message, retryable: false }));

const snapshotRunPlan = (plan: RunPlan) =>
  Schema.encodeEffect(RunPlanSchema)(plan).pipe(
    Effect.flatMap(Schema.decodeEffect(RunPlanSchema)),
    Effect.map(freezeRunPlan),
    Effect.mapError((error) =>
      RunLedgerError.make({
        operation: "accept Run",
        message: `Run Plan snapshot failed: ${error}`,
        retryable: false,
      }),
    ),
  );

const applyUpdate = (record: RunRecord, update: RunUpdate): RunRecord => ({
  ...record,
  status: update.status,
  usage: update.usage,
  endedAtMillis: update.endedAtMillis,
});

const patchRun = (runs: ReadonlyArray<RunRecord>, runId: RunId, patch: (run: RunRecord) => RunRecord) =>
  runs.map((run) => (run.id === runId ? patch(run) : run));

const transition = (
  runs: ReadonlyArray<RunRecord>,
  match: (run: RunRecord) => boolean,
  apply: (run: RunRecord) => RunRecord,
) => {
  const affected = runs.filter(match).map((run) => run.id);
  if (affected.length === 0) return [affected, runs] as const;
  return [affected, runs.map((run) => (match(run) ? apply(run) : run))] as const;
};

const closeRunningUpdate = (endedAtMillis: number): RunUpdate => ({
  status: "failed",
  usage: null,
  endedAtMillis,
});

const interrupted = (record: RunRecord, endedAtMillis: number): RunRecord => ({
  ...record,
  status: "interrupted",
  endedAtMillis,
});

const crashed = (record: RunRecord, endedAtMillis: number): RunRecord => ({
  ...record,
  status: "crashed",
  endedAtMillis,
});

const stillRunning = (record: RunRecord, startedFromMillis: number) =>
  record.status === "running" && record.startedAtMillis >= startedFromMillis;

const runningBefore = (record: RunRecord, beforeMillis: number) =>
  record.status === "running" && record.startedAtMillis < beforeMillis;

const unresumableStatuses = new Set<RunRecord["status"]>(["interrupted", "crashed", "exhausted"]);

const forItem = (workspace: string, workItem: string) => (run: RunRecord) =>
  run.workspace === workspace && run.workItem === workItem;

const consecutiveCrashesOf = (runs: ReadonlyArray<RunRecord>) => {
  const ordered = [...runs].sort((a, b) => a.startedAtMillis - b.startedAtMillis);
  const lastNonCrash = ordered.findLastIndex((run) => run.status !== "crashed");
  return ordered.length - (lastNonCrash + 1);
};

const latestRunWhere = (runs: ReadonlyArray<RunRecord>, match: (run: RunRecord) => boolean) =>
  runs.reduce<RunRecord | null>(
    (latest, run) =>
      !match(run) || (latest !== null && latest.startedAtMillis > run.startedAtMillis) ? latest : run,
    null,
  );

const resolveWatchTargetFrom = (runs: ReadonlyArray<RunRecord>, workItem: string) => {
  const candidates = workItemCandidates(workItem);
  const matches = (run: RunRecord) => candidates.includes(run.workItem);
  return (
    latestRunWhere(runs, (run) => matches(run) && run.status === "running") ?? latestRunWhere(runs, matches)
  );
};

const summaryOf = (events: ReadonlyMap<string, ReadonlyArray<RunEvent>>) => (run: RunRecord) => ({
  ...run,
  eventCount: events.get(run.id)?.length ?? 0,
});

const summarize = (
  runs: ReadonlyArray<RunRecord>,
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
  limit: number,
): ReadonlyArray<RunSummary> =>
  [...runs]
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .slice(0, limit)
    .map(summaryOf(events));

const summarizeRunning = (
  runs: ReadonlyArray<RunRecord>,
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
) =>
  [...runs]
    .filter((run) => run.status === "running")
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .map(summaryOf(events));

const sortedEvents = (
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
  runId: RunId,
): ReadonlyArray<RunEvent> => [...(events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);

const eventsForSession = (
  runs: ReadonlyArray<RunRecord>,
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
  session: SessionId,
): ReadonlyArray<RunEvent> =>
  [...runs]
    .filter((run) => run.session === session)
    .sort((a, b) => a.startedAtMillis - b.startedAtMillis)
    .flatMap((run) => sortedEvents(events, run.id));

const withHandle = (session: Session, handle: string): Session =>
  session.kind === "opaque-handle" ? { ...session, handle } : session;

export const makeMemory = Effect.gen(function* () {
  const runsRef = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
  const eventsRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<RunEvent>>>(new Map());
  const sessionsRef = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  const plansRef = yield* Ref.make<ReadonlyMap<string, RunPlan>>(new Map());

  const getSession = (id: SessionId) =>
    Effect.map(Ref.get(sessionsRef), (sessions) => sessions.get(id) ?? null);

  const acceptRun = Effect.fn("RunLedger.acceptRun")(function* (record: RunRecord, plan: RunPlan) {
    if (record.id !== plan.id) {
      return yield* runLedgerError("accept Run", `Run ${record.id} does not match Plan ${plan.id}`);
    }
    const snapshot = yield* snapshotRunPlan(plan);
    const accepted = yield* Ref.modify(plansRef, (plans) => {
      if (plans.has(record.id)) return [false, plans];
      return [true, new Map(plans).set(record.id, snapshot)];
    });
    if (!accepted) {
      return yield* runLedgerError("accept Run", `Run ${record.id} already has a Plan`);
    }
    yield* Ref.update(runsRef, (runs) => [...runs, record]);
  });

  return {
    acceptRun: (record: RunRecord, plan: RunPlan) =>
      Effect.uninterruptible(acceptRun(record, plan)).pipe(Effect.asVoid),
    getRunPlan: (runId: RunId) =>
      Effect.all([Ref.get(runsRef), Ref.get(plansRef)]).pipe(
        Effect.map(([runs, plans]) =>
          runs.some((run) => run.id === runId) ? (plans.get(runId) ?? null) : null,
        ),
      ),
    insertRun: (record: RunRecord) => Ref.update(runsRef, (runs) => [...runs, record]),
    appendEvent: (runId: RunId, event: RunEvent) =>
      Ref.update(eventsRef, (events) => new Map(events).set(runId, [...(events.get(runId) ?? []), event])),
    updateRun: (runId: RunId, update: RunUpdate) =>
      Ref.update(runsRef, (runs) => patchRun(runs, runId, (run) => applyUpdate(run, update))),
    setRunSession: (runId: RunId, session: SessionId) =>
      Ref.update(runsRef, (runs) => patchRun(runs, runId, (run) => ({ ...run, session }))),
    interruptRunning: (startedFromMillis: number, endedAtMillis: number) =>
      Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => stillRunning(run, startedFromMillis),
          (run) => interrupted(run, endedAtMillis),
        ),
      ),
    interruptRunningBefore: (beforeMillis: number, endedAtMillis: number) =>
      Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => runningBefore(run, beforeMillis),
          (run) => interrupted(run, endedAtMillis),
        ),
      ),
    crashRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => forItem(workspace, workItem)(run) && run.status === "running",
          (run) => crashed(run, endedAtMillis),
        ),
      ),
    consecutiveCrashes: (workspace: string, workItem: string) =>
      Effect.map(Ref.get(runsRef), (runs) => consecutiveCrashesOf(runs.filter(forItem(workspace, workItem)))),
    insertSession: (session: Session) =>
      Ref.update(sessionsRef, (sessions) => new Map(sessions).set(session.id, session)),
    getSession,
    recordSessionHandle: (id: SessionId, handle: string) =>
      Ref.update(sessionsRef, (sessions) => {
        const existing = sessions.get(id);
        return existing ? new Map(sessions).set(id, withHandle(existing, handle)) : sessions;
      }),
    sessionForBranch: (workspace: string, branch: string) =>
      Effect.map(
        Ref.get(runsRef),
        (runs) =>
          latestRunWhere(runs, (run) => run.workspace === workspace && run.branch === branch)?.session ??
          null,
      ),
    sessionEvents: (session: SessionId) =>
      Effect.all([Ref.get(runsRef), Ref.get(eventsRef)]).pipe(
        Effect.map(([runs, events]) => eventsForSession(runs, events, session)),
      ),
    closeRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => forItem(workspace, workItem)(run) && run.status === "running",
          (run) => applyUpdate(run, closeRunningUpdate(endedAtMillis)),
        ),
      ),
    latestRunByBranch: (workspace: string, branch: string) =>
      Effect.all([Ref.get(runsRef), Ref.get(sessionsRef)]).pipe(
        Effect.map(([runs, sessions]) =>
          latestRunWhere(
            runs,
            (run) =>
              run.session !== null &&
              !unresumableStatuses.has(run.status) &&
              run.workspace === workspace &&
              run.branch === branch &&
              sessionResumable(sessions.get(run.session) ?? null),
          ),
        ),
      ),
    latestRunForItem: (workspace: string, workItem: string) =>
      Effect.map(Ref.get(runsRef), (runs) => latestRunWhere(runs, forItem(workspace, workItem))),
    resolveWatchTarget: (workItem: string) =>
      Effect.map(Ref.get(runsRef), (runs) => resolveWatchTargetFrom(runs, workItem)),
    listRuns: (limit: number) =>
      Effect.all([Ref.get(runsRef), Ref.get(eventsRef)]).pipe(
        Effect.map(([runs, events]) => summarize(runs, events, limit)),
      ),
    runningRuns: Effect.all([Ref.get(runsRef), Ref.get(eventsRef)]).pipe(
      Effect.map(([runs, events]) => summarizeRunning(runs, events)),
    ),
    getRun: (runId: RunId) =>
      Effect.map(Ref.get(runsRef), (runs) => runs.find((run) => run.id === runId) ?? null),
    events: (runId: RunId) => Effect.map(Ref.get(eventsRef), (events) => sortedEvents(events, runId)),
  } as const;
});

export type RunLedgerService = Effect.Success<typeof makeMemory>;

export const handleOf = (ledger: RunLedgerService, session: SessionId | null) =>
  session ? Effect.map(ledger.getSession(session), sessionHandle) : Effect.succeed(null);

export class RunLedger extends Context.Service<RunLedger, RunLedgerService>()(
  "@cogwork/engine/run-ledger/RunLedger",
) {}

export class CoreRunLedger extends Context.Service<CoreRunLedger, RunLedgerService>()(
  "@cogwork/engine/run-ledger/CoreRunLedger",
) {}

const withRunChangedPublishing = (core: RunLedgerService, bus: DaemonEventBusService) => {
  const publish = Effect.fn("RunLedger.publishRunChanged")(function* (runId: RunId) {
    const run = yield* core.getRun(runId);
    if (run === null) return;
    const events = yield* core.events(runId);
    yield* bus.publishRun({ ...run, eventCount: events.length });
  });
  const publishAll = (runIds: ReadonlyArray<RunId>) => Effect.forEach(runIds, publish, { discard: true });
  return {
    ...core,
    acceptRun: (record: RunRecord, plan: RunPlan) =>
      Effect.andThen(core.acceptRun(record, plan), publish(record.id)).pipe(Effect.asVoid),
    insertRun: (record: RunRecord) => Effect.andThen(core.insertRun(record), publish(record.id)),
    updateRun: (runId: RunId, update: RunUpdate) =>
      Effect.andThen(core.updateRun(runId, update), publish(runId)),
    setRunSession: (runId: RunId, session: SessionId) =>
      Effect.andThen(core.setRunSession(runId, session), publish(runId)),
    interruptRunning: (startedFromMillis: number, endedAtMillis: number) =>
      Effect.tap(core.interruptRunning(startedFromMillis, endedAtMillis), publishAll),
    interruptRunningBefore: (beforeMillis: number, endedAtMillis: number) =>
      Effect.tap(core.interruptRunningBefore(beforeMillis, endedAtMillis), publishAll),
    crashRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      Effect.tap(core.crashRunning(workspace, workItem, endedAtMillis), publishAll),
    closeRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      Effect.tap(core.closeRunning(workspace, workItem, endedAtMillis), publishAll),
  } satisfies RunLedgerService;
};

export const layerMemoryCore = Layer.effect(CoreRunLedger, makeMemory);

export const publishingLayer = Layer.effect(
  RunLedger,
  Effect.gen(function* () {
    const core = yield* CoreRunLedger;
    const bus = yield* DaemonEventBus;
    return withRunChangedPublishing(core, bus);
  }),
);

export const layerMemory = publishingLayer.pipe(Layer.provide(layerMemoryCore));
