import type { RunEvent, RunId, RunRecord, Session, TokenUsage } from "@cogwork/contracts";
import {
  RunEvent as RunEventSchema,
  RunId as RunIdSchema,
  RunRecord as RunRecordSchema,
  RunSummary as RunSummarySchema,
  SessionId,
  Session as SessionSchema,
  workItemCandidates,
} from "@cogwork/contracts";
import { ControlStoreSchema, RunLedger } from "@cogwork/engine";
import { and, desc, eq, gt, gte, inArray, isNotNull, lt, notInArray, or, type SQL, sql } from "drizzle-orm";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const { runEvents, runs, sessions } = ControlStoreSchema;

const unresumableStatuses = ["interrupted", "crashed", "exhausted"];

const newestRunFirst = [desc(runs.startedAt), desc(sql<number>`rowid`)] as const;

const runColumns = (record: {
  readonly usage: TokenUsage | null;
  readonly status: string;
  readonly endedAtMillis: number | null;
}) => ({
  inputTokens: record.usage?.inputTokens ?? null,
  outputTokens: record.usage?.outputTokens ?? null,
  totalTokens: record.usage?.totalTokens ?? null,
  estimated: record.usage?.estimated ?? null,
  status: record.status,
  endedAt: record.endedAtMillis,
});

const sessionValues = (session: Session) => ({
  id: session.id,
  workspace: session.workspace,
  harness: session.harness,
  kind: session.kind,
  handle: session.kind === "opaque-handle" ? session.handle : null,
  createdAt: session.createdAtMillis,
});

const sessionFromRow = (row: {
  readonly id: string;
  readonly workspace: string;
  readonly harness: string;
  readonly kind: string;
  readonly handle: string | null;
  readonly createdAt: number;
}) => {
  const base = {
    kind: row.kind,
    id: row.id,
    workspace: row.workspace,
    harness: row.harness,
    createdAtMillis: row.createdAt,
  };
  return row.kind === "opaque-handle" ? { ...base, handle: row.handle } : base;
};

const usageOf = (row: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly estimated: boolean | null;
}): TokenUsage | null => {
  if (row.inputTokens === null && row.outputTokens === null && row.totalTokens === null) return null;
  return {
    ...(row.inputTokens === null ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === null ? {} : { outputTokens: row.outputTokens }),
    ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
    ...(row.estimated ? { estimated: true } : {}),
  };
};

const runRecordSelection = {
  id: runs.id,
  workspace: runs.workspace,
  workItem: runs.workItem,
  stage: runs.stage,
  harness: runs.harness,
  branch: runs.branch,
  session: runs.session,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  totalTokens: runs.totalTokens,
  estimated: runs.estimated,
  status: runs.status,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
};

const runRecordFromRow = (row: {
  readonly id: string;
  readonly workspace: string;
  readonly workItem: string;
  readonly stage: string;
  readonly harness: string;
  readonly branch: string | null;
  readonly session: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly estimated: boolean | null;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}) => ({
  id: row.id,
  workspace: row.workspace,
  workItem: row.workItem,
  stage: row.stage,
  harness: row.harness,
  branch: row.branch,
  session: row.session,
  usage: usageOf(row),
  status: row.status,
  startedAtMillis: row.startedAt,
  endedAtMillis: row.endedAt,
});

const decodeSummary = Schema.decodeUnknownEffect(RunSummarySchema);
const decodeRunId = Schema.decodeUnknownEffect(RunIdSchema);
const decodeEvent = Schema.decodeUnknownEffect(RunEventSchema);
const decodeRun = Schema.decodeUnknownEffect(RunRecordSchema);
const decodeSession = Schema.decodeUnknownEffect(SessionSchema);
const decodeSessionId = Schema.decodeUnknownEffect(SessionId);

const decodeAll = <A, E, R>(decode: (u: unknown) => Effect.Effect<A, E, R>, rows: ReadonlyArray<unknown>) =>
  Effect.forEach(rows, (row) =>
    decode(row).pipe(
      Effect.map((value) => [value] as const),
      Effect.orElseSucceed(() => [] as const),
    ),
  ).pipe(Effect.map((chunks) => chunks.flat()));

const make = Effect.fn("ledger.make")(function* () {
  const db = yield* SQLiteNodeDrizzle.makeWithDefaults();

  // Taken as a thunk: building the query runs Drizzle's compiler, which can throw before any
  // Effect exists to fail.
  const swallow = <A, E>(operation: string, query: () => Effect.Effect<A, E>, fallback: () => A) =>
    Effect.suspend(query).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.andThen(
          Effect.logWarning(`run ledger ${operation} failed`, { cause: Cause.pretty(cause) }),
          Effect.sync(fallback),
        );
      }),
    );

  const write = <E>(operation: string, query: () => Effect.Effect<unknown, E>) =>
    Effect.asVoid(swallow(operation, query, () => undefined));

  const readRows = <A, E>(operation: string, query: () => Effect.Effect<ReadonlyArray<A>, E>) =>
    swallow(operation, query, () => [] as ReadonlyArray<A>);

  const writeIds = <E>(
    operation: string,
    query: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>, E>,
  ) =>
    readRows(operation, query).pipe(
      Effect.flatMap((rows) =>
        decodeAll(
          decodeRunId,
          rows.map((row) => row.id),
        ),
      ),
    );

  const readRun = <E>(
    operation: string,
    query: () => Effect.Effect<Parameters<typeof runRecordFromRow>[0] | undefined, E>,
  ) =>
    swallow(operation, query, () => undefined).pipe(
      Effect.flatMap((row) =>
        row ? decodeRun(runRecordFromRow(row)).pipe(Effect.orElseSucceed(() => null)) : Effect.succeed(null),
      ),
    );

  const latestRunWhere = (operation: string, where: SQL | undefined) =>
    readRun(operation, () =>
      db
        .select(runRecordSelection)
        .from(runs)
        .where(where)
        .orderBy(...newestRunFirst)
        .limit(1)
        .get(),
    );

  const service: RunLedger.RunLedgerService = {
    insertRun: (record: RunRecord) => {
      const values = {
        id: record.id,
        workspace: record.workspace,
        workItem: record.workItem,
        stage: record.stage,
        harness: record.harness,
        branch: record.branch,
        session: record.session,
        startedAt: record.startedAtMillis,
        ...runColumns(record),
      };
      return write("insertRun", () =>
        db.insert(runs).values(values).onConflictDoUpdate({ target: runs.id, set: values }).run(),
      );
    },

    updateRun: (runId: RunId, patch: RunLedger.RunUpdate) =>
      write("updateRun", () => db.update(runs).set(runColumns(patch)).where(eq(runs.id, runId)).run()),

    setRunSession: (runId: RunId, session: SessionId) =>
      write("setRunSession", () => db.update(runs).set({ session }).where(eq(runs.id, runId)).run()),

    interruptRunning: (startedFromMillis: number, endedAtMillis: number) =>
      writeIds("interruptRunning", () =>
        db
          .update(runs)
          .set({ status: "interrupted", endedAt: endedAtMillis })
          .where(and(eq(runs.status, "running"), gte(runs.startedAt, startedFromMillis)))
          .returning({ id: runs.id })
          .all(),
      ),

    interruptRunningBefore: (beforeMillis: number, endedAtMillis: number) =>
      writeIds("interruptRunningBefore", () =>
        db
          .update(runs)
          .set({ status: "interrupted", endedAt: endedAtMillis })
          .where(and(eq(runs.status, "running"), lt(runs.startedAt, beforeMillis)))
          .returning({ id: runs.id })
          .all(),
      ),

    insertSession: (session: Session) =>
      write("insertSession", () =>
        db.insert(sessions).values(sessionValues(session)).onConflictDoNothing().run(),
      ),

    getSession: (id) =>
      swallow(
        "getSession",
        () => db.select().from(sessions).where(eq(sessions.id, id)).get(),
        () => undefined,
      ).pipe(
        Effect.flatMap((row) =>
          row
            ? decodeSession(sessionFromRow(row)).pipe(Effect.orElseSucceed(() => null))
            : Effect.succeed(null),
        ),
      ),

    recordSessionHandle: (id, handle: string) =>
      write("recordSessionHandle", () =>
        db.update(sessions).set({ handle }).where(eq(sessions.id, id)).run(),
      ),

    sessionForBranch: (workspace: string, branch: string) =>
      readRows("sessionForBranch", () =>
        db
          .select({ session: runs.session })
          .from(runs)
          .where(and(eq(runs.workspace, workspace), eq(runs.branch, branch), isNotNull(runs.session)))
          .orderBy(desc(runs.startedAt), desc(sql<number>`"runs".rowid`))
          .limit(1)
          .all(),
      ).pipe(
        Effect.flatMap((rows) => {
          const raw = rows[0]?.session;
          return raw ? decodeSessionId(raw).pipe(Effect.orElseSucceed(() => null)) : Effect.succeed(null);
        }),
      ),

    sessionEvents: (session) =>
      readRows("sessionEvents", () =>
        db
          .select({
            seq: runEvents.seq,
            type: runEvents.type,
            name: runEvents.name,
            data: runEvents.data,
            at: runEvents.at,
          })
          .from(runEvents)
          .innerJoin(runs, eq(runs.id, runEvents.runId))
          .where(eq(runs.session, session))
          .orderBy(runs.startedAt, runEvents.seq)
          .all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeAll(
            decodeEvent,
            rows.map((row) => ({
              seq: row.seq,
              type: row.type,
              name: row.name,
              data: row.data,
              atMillis: row.at,
            })),
          ),
        ),
      ),

    closeRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      writeIds("closeRunning", () =>
        db
          .update(runs)
          .set({ status: "failed", endedAt: endedAtMillis })
          .where(and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")))
          .returning({ id: runs.id })
          .all(),
      ),

    crashRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
      writeIds("crashRunning", () =>
        db
          .update(runs)
          .set({ status: "crashed", endedAt: endedAtMillis })
          .where(and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")))
          .returning({ id: runs.id })
          .all(),
      ),

    consecutiveCrashes: (workspace: string, workItem: string) =>
      readRows("consecutiveCrashes", () =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(runs)
          .where(
            and(
              eq(runs.workspace, workspace),
              eq(runs.workItem, workItem),
              eq(runs.status, "crashed"),
              gt(
                runs.startedAt,
                sql<number>`coalesce((select max(${runs.startedAt}) from ${runs} where ${runs.workspace} = ${workspace} and ${runs.workItem} = ${workItem} and ${runs.status} <> 'crashed'), -1)`,
              ),
            ),
          )
          .all(),
      ).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0))),

    appendEvent: (runId: RunId, event: RunEvent) => {
      const values = {
        runId,
        seq: event.seq,
        type: event.type,
        name: event.name,
        data: event.data,
        at: event.atMillis,
      };
      return write("appendEvent", () =>
        db
          .insert(runEvents)
          .values(values)
          .onConflictDoUpdate({ target: [runEvents.runId, runEvents.seq], set: values })
          .run(),
      );
    },

    latestRunByBranch: (workspace: string, branch: string) =>
      readRun("latestRunByBranch", () =>
        db
          .select(runRecordSelection)
          .from(runs)
          .innerJoin(sessions, eq(sessions.id, runs.session))
          .where(
            and(
              eq(runs.workspace, workspace),
              eq(runs.branch, branch),
              notInArray(runs.status, unresumableStatuses),
              or(eq(sessions.kind, "owned-transcript"), isNotNull(sessions.handle)),
            ),
          )
          .orderBy(desc(runs.startedAt), desc(sql<number>`"runs".rowid`))
          .limit(1)
          .get(),
      ),

    latestRunForItem: (workspace: string, workItem: string) =>
      latestRunWhere("latestRunForItem", and(eq(runs.workspace, workspace), eq(runs.workItem, workItem))),

    resolveWatchTarget: (workItem: string) =>
      readRun("resolveWatchTarget", () =>
        db
          .select(runRecordSelection)
          .from(runs)
          .where(inArray(runs.workItem, [...workItemCandidates(workItem)]))
          .orderBy(desc(sql<boolean>`${runs.status} = 'running'`), desc(runs.startedAt))
          .limit(1)
          .get(),
      ),

    listRuns: (limit: number) =>
      readRows("listRuns", () =>
        db
          .select({
            ...runRecordSelection,
            eventCount: sql<number>`(select count(*) from ${runEvents} where ${runEvents.runId} = ${runs.id})`,
          })
          .from(runs)
          .orderBy(desc(runs.startedAt))
          .limit(limit)
          .all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeAll(
            decodeSummary,
            rows.map((row) => ({ ...runRecordFromRow(row), eventCount: Number(row.eventCount) })),
          ),
        ),
      ),

    runningRuns: readRows("runningRuns", () =>
      db
        .select({
          ...runRecordSelection,
          eventCount: sql<number>`(select count(*) from ${runEvents} where ${runEvents.runId} = ${runs.id})`,
        })
        .from(runs)
        .where(eq(runs.status, "running"))
        .orderBy(desc(runs.startedAt))
        .all(),
    ).pipe(
      Effect.flatMap((rows) =>
        decodeAll(
          decodeSummary,
          rows.map((row) => ({ ...runRecordFromRow(row), eventCount: Number(row.eventCount) })),
        ),
      ),
    ),

    getRun: (runId: RunId) =>
      readRun("getRun", () => db.select(runRecordSelection).from(runs).where(eq(runs.id, runId)).get()),

    events: (runId: RunId) =>
      readRows("events", () =>
        db
          .select({
            seq: runEvents.seq,
            type: runEvents.type,
            name: runEvents.name,
            data: runEvents.data,
            at: runEvents.at,
          })
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .orderBy(runEvents.seq)
          .all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeAll(
            decodeEvent,
            rows.map((row) => ({
              seq: row.seq,
              type: row.type,
              name: row.name,
              data: row.data,
              atMillis: row.at,
            })),
          ),
        ),
      ),
  };

  return service;
});

export const layer = Layer.effect(RunLedger.CoreRunLedger, make());
