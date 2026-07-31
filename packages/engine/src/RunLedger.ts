import type { RunEvent, RunId, RunRecord, RunSummary, SessionId, TokenUsage } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface RunUpdate {
  readonly status: RunSummary["status"];
  readonly session: SessionId | null;
  readonly usage: TokenUsage | null;
  readonly endedAtMillis: number;
}

const applyUpdate = (record: RunRecord, update: RunUpdate): RunRecord => ({
  ...record,
  status: update.status,
  session: update.session,
  usage: update.usage,
  endedAtMillis: update.endedAtMillis,
});

const latestSessionWhere = (runs: ReadonlyArray<RunRecord>, match: (run: RunRecord) => boolean) =>
  runs
    .filter((run) => run.session !== null && match(run))
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .at(0)?.session ?? null;

const summarize = (
  runs: ReadonlyArray<RunRecord>,
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
  limit: number,
): ReadonlyArray<RunSummary> =>
  [...runs]
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .slice(0, limit)
    .map((run) => ({ ...run, eventCount: events.get(run.id)?.length ?? 0 }));

const sortedEvents = (
  events: ReadonlyMap<string, ReadonlyArray<RunEvent>>,
  runId: RunId,
): ReadonlyArray<RunEvent> => [...(events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);

export const makeMemory = Effect.gen(function* () {
  const runsRef = yield* Ref.make<ReadonlyArray<RunRecord>>([]);
  const eventsRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<RunEvent>>>(new Map());
  return {
    insertRun: (record: RunRecord) => Ref.update(runsRef, (runs) => [...runs, record]),
    appendEvent: (runId: RunId, event: RunEvent) =>
      Ref.update(eventsRef, (events) => new Map(events).set(runId, [...(events.get(runId) ?? []), event])),
    updateRun: (runId: RunId, update: RunUpdate) =>
      Ref.update(runsRef, (runs) => runs.map((run) => (run.id === runId ? applyUpdate(run, update) : run))),
    latestSessionByBranch: (workspace: string, branch: string) =>
      Effect.map(Ref.get(runsRef), (runs) =>
        latestSessionWhere(runs, (run) => run.workspace === workspace && run.branch === branch),
      ),
    listRuns: (limit: number) =>
      Effect.all([Ref.get(runsRef), Ref.get(eventsRef)]).pipe(
        Effect.map(([runs, events]) => summarize(runs, events, limit)),
      ),
    events: (runId: RunId) => Effect.map(Ref.get(eventsRef), (events) => sortedEvents(events, runId)),
  } as const;
});

export type RunLedgerService = Effect.Success<typeof makeMemory>;

export class RunLedger extends Context.Service<RunLedger, RunLedgerService>()(
  "@clanker-forge/engine/RunLedger",
) {}

export const layerMemory = Layer.effect(RunLedger, makeMemory);
