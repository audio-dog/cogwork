import type {
  BranchName,
  RunEvent,
  RunHistory,
  RunId,
  RunPlan,
  RunRecord,
  RunSummary,
  Session,
  SessionId,
  TokenUsage,
  WorkItemId,
  WorkspaceId,
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
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DaemonEventBus, type DaemonEventBusService } from "./daemon-event-bus";
import { freezeRunPlan } from "./run-plan";

export interface RunUpdate {
  readonly status: RunSummary["status"];
  readonly usage: TokenUsage | null;
  readonly endedAtMillis: number;
}

export const acceptRunOperation = "accept Run";
export const encodeRunEventOperation = "encode run event";
export const readRunEventsOperation = "read Run events";
export const runEventPageSize = 256;
export const runEventPageBudgetBytes = 1024 * 1024;
const RunLedgerErrorOperation = Schema.Literals([
  acceptRunOperation,
  encodeRunEventOperation,
  readRunEventsOperation,
]);

export class RunLedgerError extends Schema.TaggedError<RunLedgerError>()("RunLedgerError", {
  operation: RunLedgerErrorOperation,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

const acceptRunError = (message: string) =>
  Effect.fail(RunLedgerError.make({ operation: acceptRunOperation, message, retryable: false }));

const encodeRunPlan = Schema.encodeEffect(RunPlanSchema);
const decodeRunPlan = Schema.decodeEffect(RunPlanSchema);

const snapshotRunPlan = (plan: RunPlan) =>
  encodeRunPlan(plan).pipe(
    Effect.flatMap(decodeRunPlan),
    Effect.map(freezeRunPlan),
    Effect.mapError((error) =>
      RunLedgerError.make({
        operation: acceptRunOperation,
        message: `Run Plan snapshot failed: ${error}`,
        retryable: false,
      }),
    ),
  );

const applyUpdate = (record: RunRecord, update: RunUpdate): RunRecord => ({
  ...record,
  ...update,
});

const patchRun = (runs: ReadonlyArray<RunRecord>, runId: RunId, patch: (run: RunRecord) => RunRecord) =>
  runs.map((run) => (run.id === runId ? patch(run) : run));

const runningForItem = (workspace: WorkspaceId, workItem: WorkItemId) => (run: RunRecord) =>
  forItem(workspace, workItem)(run) && run.status === "running";

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

const forItem = (workspace: WorkspaceId, workItem: WorkItemId) => (run: RunRecord) =>
  run.workspace === workspace && run.workItem === workItem;

const consecutiveCrashesOf = (runs: ReadonlyArray<RunRecord>, sinceMillis: number) => {
  const ordered = runs
    .filter((run) => run.startedAtMillis > sinceMillis)
    .toSorted((a, b) => a.startedAtMillis - b.startedAtMillis);
  const lastNonCrash = ordered.findLastIndex((run) => run.status !== "crashed");
  return ordered.length - (lastNonCrash + 1);
};

const latestRunWhere = (runs: ReadonlyArray<RunRecord>, match: (run: RunRecord) => boolean) =>
  runs.reduce<RunRecord | null>((latest, run) => {
    if (!match(run)) return latest;
    if (latest !== null && latest.startedAtMillis > run.startedAtMillis) return latest;
    return run;
  }, null);

const resolveWatchTargetFrom = (runs: ReadonlyArray<RunRecord>, workItem: WorkItemId) => {
  const candidates = workItemCandidates(workItem);
  const matches = (run: RunRecord) => candidates.includes(run.workItem);
  return (
    latestRunWhere(runs, (run) => matches(run) && run.status === "running") ?? latestRunWhere(runs, matches)
  );
};

export const logRunAccepted = (record: RunRecord) =>
  Effect.logInfo("accepted Run", { harness: record.harness, branch: record.branch });

export const logRunEventAppended = (event: RunEvent) =>
  Effect.logInfo("appended Run event", { seq: event.seq });

export const logRunSettled = (status: RunRecord["status"]) => Effect.logInfo("settled Run", { status });

export const logRunsSettled = (runIds: ReadonlyArray<RunId>, status: RunRecord["status"]) =>
  Effect.forEach(runIds, () => logRunSettled(status), { discard: true });

export const logRunUpdateRefused = (requested: RunRecord["status"]) =>
  Effect.logWarning("refused a status change to a Run that is not running", { requested });

type MemoryEvents = ReadonlyMap<RunId, ReadonlyArray<RunEvent>>;

const eventCountOf = (events: MemoryEvents, runId: RunId) => events.get(runId)?.length ?? 0;

const summaryOf =
  (events: MemoryEvents) =>
  (run: RunRecord): RunSummary => ({
    ...run,
    eventCount: eventCountOf(events, run.id),
    eventsPrunedAtMillis: null,
  });

const summarize = (
  runs: ReadonlyArray<RunRecord>,
  events: MemoryEvents,
  limit: number,
): ReadonlyArray<RunSummary> =>
  [...runs]
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .slice(0, limit)
    .map(summaryOf(events));

const summarizeRunning = (runs: ReadonlyArray<RunRecord>, events: MemoryEvents) =>
  [...runs]
    .filter((run) => run.status === "running")
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .map(summaryOf(events));

const eventsForRun = (events: MemoryEvents, runId: RunId) => events.get(runId) ?? [];

interface EventPageState {
  readonly events: ReadonlyArray<RunEvent>;
  readonly bytes: number;
  readonly full: boolean;
}

const emptyEventPage: EventPageState = { events: [], bytes: 0, full: false };

const appendToEventPage = (page: EventPageState, event: RunEvent) => {
  if (page.full) return page;
  const bytes = page.bytes + new TextEncoder().encode(event.data).byteLength;
  if (page.events.length > 0 && bytes > runEventPageBudgetBytes) return { ...page, full: true };
  return { events: [...page.events, event], bytes, full: false };
};

const eventPageAt = (events: ReadonlyArray<RunEvent>, index: number) =>
  events.slice(index, index + runEventPageSize).reduce(appendToEventPage, emptyEventPage).events;

const nextPageIndex = (index: number, page: ReadonlyArray<RunEvent>) =>
  page.length === 0 ? Option.none<number>() : Option.some(index + page.length);

const eventsForSession = (
  runs: ReadonlyArray<RunRecord>,
  events: MemoryEvents,
  session: SessionId,
): ReadonlyArray<RunEvent> =>
  [...runs]
    .filter((run) => run.session === session)
    .sort((a, b) => a.startedAtMillis - b.startedAtMillis)
    .flatMap((run) => eventsForRun(events, run.id));

const withHandle = (session: Session, handle: string): Session =>
  session.kind === "opaque-handle" ? { ...session, handle } : session;

export const makeMemory = Effect.gen(function* () {
  const runsRef = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
  const eventsRef = yield* Ref.make<MemoryEvents>(new Map());
  const sessionsRef = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  const plansRef = yield* Ref.make<ReadonlyMap<string, RunPlan>>(new Map());

  const getSession = (id: SessionId) =>
    Effect.map(Ref.get(sessionsRef), (sessions) => sessions.get(id) ?? null);

  const acceptRun = Effect.fn("RunLedger.acceptRun")(function* (record: RunRecord, plan: RunPlan) {
    if (record.id !== plan.id) {
      return yield* acceptRunError(`Run ${record.id} does not match Plan ${plan.id}`);
    }
    const snapshot = yield* snapshotRunPlan(plan);
    const accepted = yield* Ref.modify(plansRef, (plans) => {
      if (plans.has(record.id)) return [false, plans];
      return [true, new Map(plans).set(record.id, snapshot)];
    });
    if (!accepted) {
      return yield* acceptRunError(`Run ${record.id} already has a Plan`);
    }
    yield* Ref.update(runsRef, (runs) => [...runs, record]);
    yield* logRunAccepted(record);
  });

  const appendEvent = Effect.fn("RunLedger.appendEvent")(function* (runId: RunId, event: RunEvent) {
    yield* Ref.update(eventsRef, (events) =>
      new Map(events).set(runId, [...eventsForRun(events, runId), event]),
    );
    yield* logRunEventAppended(event);
  });

  const updateRun = Effect.fn("RunLedger.updateRun")(function* (runId: RunId, update: RunUpdate) {
    const updated = yield* Ref.modify(runsRef, (runs) => {
      const running = runs.some((run) => run.id === runId && run.status === "running");
      return [running, running ? patchRun(runs, runId, (run) => applyUpdate(run, update)) : runs];
    });
    if (!updated) return yield* logRunUpdateRefused(update.status);
    yield* logRunSettled(update.status);
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
    appendEvent,
    updateRun,
    setRunSession: (runId: RunId, session: SessionId) =>
      Ref.update(runsRef, (runs) => patchRun(runs, runId, (run) => ({ ...run, session }))),
    interruptRunning: Effect.fn("RunLedger.interruptRunning")(function* (
      startedFromMillis: number,
      endedAtMillis: number,
    ) {
      const runIds = yield* Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => stillRunning(run, startedFromMillis),
          (run) => interrupted(run, endedAtMillis),
        ),
      );
      yield* logRunsSettled(runIds, "interrupted");
      return runIds;
    }),
    interruptRunningBefore: Effect.fn("RunLedger.interruptRunningBefore")(function* (
      beforeMillis: number,
      endedAtMillis: number,
    ) {
      const runIds = yield* Ref.modify(runsRef, (runs) =>
        transition(
          runs,
          (run) => runningBefore(run, beforeMillis),
          (run) => interrupted(run, endedAtMillis),
        ),
      );
      yield* logRunsSettled(runIds, "interrupted");
      return runIds;
    }),
    crashRunning: Effect.fn("RunLedger.crashRunning")(function* (
      workspace: WorkspaceId,
      workItem: WorkItemId,
      endedAtMillis: number,
    ) {
      const runIds = yield* Ref.modify(runsRef, (runs) =>
        transition(runs, runningForItem(workspace, workItem), (run) => crashed(run, endedAtMillis)),
      );
      yield* logRunsSettled(runIds, "crashed");
      return runIds;
    }),
    consecutiveCrashes: (workspace: WorkspaceId, workItem: WorkItemId, sinceMillis: number) =>
      Effect.map(Ref.get(runsRef), (runs) =>
        consecutiveCrashesOf(runs.filter(forItem(workspace, workItem)), sinceMillis),
      ),
    insertSession: (session: Session) =>
      Ref.update(sessionsRef, (sessions) => new Map(sessions).set(session.id, session)),
    getSession,
    recordSessionHandle: (id: SessionId, handle: string) =>
      Ref.update(sessionsRef, (sessions) => {
        const existing = sessions.get(id);
        return existing ? new Map(sessions).set(id, withHandle(existing, handle)) : sessions;
      }),
    sessionForBranch: (workspace: WorkspaceId, branch: BranchName) =>
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
    closeRunning: Effect.fn("RunLedger.closeRunning")(function* (
      workspace: WorkspaceId,
      workItem: WorkItemId,
      endedAtMillis: number,
    ) {
      const runIds = yield* Ref.modify(runsRef, (runs) =>
        transition(runs, runningForItem(workspace, workItem), (run) =>
          applyUpdate(run, closeRunningUpdate(endedAtMillis)),
        ),
      );
      yield* logRunsSettled(runIds, "failed");
      return runIds;
    }),
    latestRunByBranch: (workspace: WorkspaceId, branch: BranchName) =>
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
    latestRunForItem: (workspace: WorkspaceId, workItem: WorkItemId) =>
      Effect.map(Ref.get(runsRef), (runs) => latestRunWhere(runs, forItem(workspace, workItem))),
    resolveWatchTarget: (workItem: WorkItemId) =>
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
    getRunSummary: (runId: RunId) =>
      Effect.all([Ref.get(runsRef), Ref.get(eventsRef)]).pipe(
        Effect.map(([runs, events]) => {
          const run = runs.find((candidate) => candidate.id === runId);
          return run ? summaryOf(events)(run) : null;
        }),
      ),
    latestSeq: (runId: RunId): Effect.Effect<number | null, RunLedgerError> =>
      Effect.map(Ref.get(eventsRef), (events) => eventsForRun(events, runId).at(-1)?.seq ?? null),
    events: (runId: RunId): Stream.Stream<RunEvent, RunLedgerError> =>
      Stream.unwrap(
        Effect.map(Ref.get(eventsRef), (events) => {
          const snapshot = eventsForRun(events, runId);
          return Stream.paginate(0, (index) => {
            const page = eventPageAt(snapshot, index);
            return Effect.succeed([page, nextPageIndex(index, page)] satisfies readonly [
              ReadonlyArray<RunEvent>,
              Option.Option<number>,
            ]);
          });
        }),
      ),
  } as const;
});

export type CoreRunLedgerService = Effect.Success<typeof makeMemory>;
export type RunLedgerService = Omit<CoreRunLedgerService, "getRunSummary"> & {
  readonly history: (runId: RunId) => Effect.Effect<RunHistory, RunLedgerError>;
};

export const handleOf = (ledger: RunLedgerService, session: SessionId | null) =>
  session ? Effect.map(ledger.getSession(session), sessionHandle) : Effect.succeed(null);

export class RunLedger extends Context.Service<RunLedger, RunLedgerService>()(
  "@cogwork/engine/run-ledger/RunLedger",
) {}

export class CoreRunLedger extends Context.Service<CoreRunLedger, CoreRunLedgerService>()(
  "@cogwork/engine/run-ledger/CoreRunLedger",
) {}

const makeRunLedgerService = (core: CoreRunLedgerService, bus: DaemonEventBusService) => {
  const { getRunSummary, ...ledger } = core;
  const history = Effect.fn("RunLedger.history")((runId: RunId) =>
    Effect.all([ledger.events(runId).pipe(Stream.runCollect), getRunSummary(runId)]).pipe(
      Effect.map(([events, run]) => ({
        events,
        eventsPrunedAtMillis: run?.eventsPrunedAtMillis ?? null,
      })),
    ),
  );
  const publish = Effect.fn("RunLedger.publishRunChanged")(function* (runId: RunId) {
    const run = yield* getRunSummary(runId);
    if (run === null) return;
    yield* bus.publishRun(run);
  });
  const publishAll = (runIds: ReadonlyArray<RunId>) => Effect.forEach(runIds, publish, { discard: true });
  return {
    ...ledger,
    history,
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
    crashRunning: (workspace: WorkspaceId, workItem: WorkItemId, endedAtMillis: number) =>
      Effect.tap(core.crashRunning(workspace, workItem, endedAtMillis), publishAll),
    closeRunning: (workspace: WorkspaceId, workItem: WorkItemId, endedAtMillis: number) =>
      Effect.tap(core.closeRunning(workspace, workItem, endedAtMillis), publishAll),
  } satisfies RunLedgerService;
};

export const layerMemoryCore = Layer.effect(CoreRunLedger, makeMemory);

export const publishingLayer = Layer.effect(
  RunLedger,
  Effect.gen(function* () {
    const core = yield* CoreRunLedger;
    const bus = yield* DaemonEventBus;
    return makeRunLedgerService(core, bus);
  }),
);

export const layerMemory = publishingLayer.pipe(Layer.provide(layerMemoryCore));
