import type {
  BranchName,
  RunEvent,
  RunId,
  RunPlan,
  RunRecord,
  Session,
  TokenUsage,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import {
  RunEvent as RunEventSchema,
  RunId as RunIdSchema,
  RunPlan as RunPlanSchema,
  RunRecord as RunRecordSchema,
  RunSummary as RunSummarySchema,
  SessionId,
  Session as SessionSchema,
  workItemCandidates,
} from "@cogwork/contracts";
import { ControlStoreSchema, RunLedger } from "@cogwork/engine";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { and, desc, eq, gt, gte, inArray, isNotNull, lt, notInArray, or, type SQL, sql } from "drizzle-orm";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlError from "effect/unstable/sql/SqlError";

const { runEvents, runPlans, runs, sessions } = ControlStoreSchema;

export const runLedgerAppendDuration = Metric.timer("cogwork_run_ledger_append_duration", {
  description: "Time to append one event to the Run ledger.",
});

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

const runValues = (record: RunRecord) => ({
  id: record.id,
  workspace: record.workspace,
  workItem: record.workItem,
  subjectTitle: record.subject?.title ?? null,
  subjectUrl: record.subject?.url ?? null,
  operation: record.operation,
  harness: record.harness,
  branch: record.branch,
  session: record.session,
  startedAt: record.startedAtMillis,
  ...runColumns(record),
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
  subjectTitle: runs.subjectTitle,
  subjectUrl: runs.subjectUrl,
  operation: runs.operation,
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

const runSummarySelection = {
  ...runRecordSelection,
  eventCount: runs.eventCount,
  eventsPrunedAt: runs.eventsPrunedAt,
};

const runRecordFromRow = (row: {
  readonly id: string;
  readonly workspace: string;
  readonly workItem: string;
  readonly subjectTitle: string | null;
  readonly subjectUrl: string | null;
  readonly operation: string;
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
  ...(row.subjectTitle === null ? {} : { subject: { title: row.subjectTitle, url: row.subjectUrl } }),
  operation: row.operation,
  harness: row.harness,
  branch: row.branch,
  session: row.session,
  usage: usageOf(row),
  status: row.status,
  startedAtMillis: row.startedAt,
  endedAtMillis: row.endedAt,
});

const runSummaryFromRow = (
  row: Parameters<typeof runRecordFromRow>[0] & {
    readonly eventCount: number;
    readonly eventsPrunedAt: number | null;
  },
) => ({
  ...runRecordFromRow(row),
  eventCount: row.eventCount,
  eventsPrunedAtMillis: row.eventsPrunedAt,
});

type RunRow = Parameters<typeof runRecordFromRow>[0];
type RunSummaryRow = Parameters<typeof runSummaryFromRow>[0];

interface RunEventRow {
  readonly seq: number;
  readonly type: string;
  readonly name: string | null;
  readonly data: string;
  readonly at: number;
}

const decodeSummary = Schema.decodeUnknownEffect(RunSummarySchema);
const decodeRunId = Schema.decodeUnknownEffect(RunIdSchema);
const decodeEvent = Schema.decodeUnknownEffect(RunEventSchema);
const decodeRun = Schema.decodeUnknownEffect(RunRecordSchema);
const decodeSession = Schema.decodeUnknownEffect(SessionSchema);
const decodeSessionId = Schema.decodeUnknownEffect(SessionId);
const decodeRunPlan = Schema.decodeUnknownEffect(Schema.fromJsonString(RunPlanSchema));
const encodeRunPlan = Schema.encodeSync(Schema.fromJsonString(RunPlanSchema));
const runPlanError = (message: string) =>
  Effect.fail(
    RunLedger.RunLedgerError.make({ operation: RunLedger.acceptRunOperation, message, retryable: false }),
  );

const decodeOrElse = <A, E, R, B>(
  operation: string,
  rowId: string,
  decode: Effect.Effect<A, E, R>,
  fallback: B,
) =>
  decode.pipe(
    Effect.catch((error) =>
      Effect.logWarning("run ledger stored row decode failed", { cause: String(error) }).pipe(
        Effect.annotateLogs({ operation, rowId }),
        Effect.map(() => fallback),
      ),
    ),
  );

const decodeAll = <A, E, R>(
  operation: string,
  decode: (u: unknown) => Effect.Effect<A, E, R>,
  rows: ReadonlyArray<{ readonly rowId: string; readonly value: unknown }>,
) =>
  Effect.forEach(rows, (row) =>
    decodeOrElse(
      operation,
      row.rowId,
      decode(row.value).pipe(Effect.map((value) => [value] as const)),
      [] as const,
    ),
  ).pipe(Effect.map((chunks) => chunks.flat()));

const make = Effect.fn("ledger.make")(function* () {
  const db = yield* SQLiteNodeDrizzle.makeWithDefaults();
  const sqlClient = yield* SqliteClient.SqliteClient;

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

  const hardOperation = <A, E>(
    operation: RunLedger.RunLedgerError["operation"],
    query: () => Effect.Effect<A, E>,
  ) =>
    Effect.suspend(query).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const retryable = cause.reasons.some(
          (reason) =>
            Cause.isFailReason(reason) && SqlError.isSqlError(reason.error) && reason.error.isRetryable,
        );
        return Effect.fail(
          RunLedger.RunLedgerError.make({
            operation,
            message: Cause.pretty(cause),
            retryable,
          }),
        );
      }),
    );

  const hardWrite = <A, E>(query: () => Effect.Effect<A, E>) =>
    hardOperation(RunLedger.acceptRunOperation, query);

  const writeIds = <E>(
    operation: string,
    query: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>, E>,
  ) =>
    readRows(operation, query).pipe(
      Effect.flatMap((rows) =>
        decodeAll(
          operation,
          decodeRunId,
          rows.map((row) => ({ rowId: row.id, value: row.id })),
        ),
      ),
    );

  const readRun = <E>(operation: string, query: () => Effect.Effect<RunRow | undefined, E>) =>
    swallow(operation, query, () => undefined).pipe(
      Effect.flatMap((row) =>
        row ? decodeOrElse(operation, row.id, decodeRun(runRecordFromRow(row)), null) : Effect.succeed(null),
      ),
    );

  const readRunSummary = <E>(operation: string, query: () => Effect.Effect<RunSummaryRow | undefined, E>) =>
    swallow(operation, query, () => undefined).pipe(
      Effect.flatMap((row) =>
        row
          ? decodeOrElse(operation, row.id, decodeSummary(runSummaryFromRow(row)), null)
          : Effect.succeed(null),
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

  const readEventPage = Effect.fn("ledger.readEventPage")(function* (runId: RunId, afterSeq: number) {
    const rows = yield* hardOperation(RunLedger.readRunEventsOperation, () =>
      sqlClient.unsafe<RunEventRow>(
        `WITH candidates AS (
          SELECT
            seq,
            type,
            name,
            data,
            at,
            sum(length(CAST(data AS BLOB))) OVER (ORDER BY seq) AS page_bytes,
            row_number() OVER (ORDER BY seq) AS page_row
          FROM (
            SELECT seq, type, name, data, at
            FROM run_events
            WHERE run_id = ? AND seq > ?
            ORDER BY seq
            LIMIT ?
          )
        )
        SELECT seq, type, name, data, at
        FROM candidates
        WHERE page_row = 1 OR page_bytes <= ?
        ORDER BY seq`,
        [runId, afterSeq, RunLedger.runEventPageSize, RunLedger.runEventPageBudgetBytes],
      ),
    );
    const events = yield* decodeAll(
      "events",
      decodeEvent,
      rows.map((row) => ({
        rowId: `${runId}:${row.seq}`,
        value: {
          seq: row.seq,
          type: row.type,
          name: row.name,
          data: row.data,
          atMillis: row.at,
        },
      })),
    );
    return [events, Option.fromNullishOr(rows.at(-1)?.seq)] satisfies readonly [
      ReadonlyArray<RunEvent>,
      Option.Option<number>,
    ];
  });

  const service: RunLedger.CoreRunLedgerService = {
    acceptRun: Effect.fn("RunLedger.acceptRun")(function* (record: RunRecord, plan: RunPlan) {
      if (record.id !== plan.id) {
        return yield* runPlanError(`Run ${record.id} does not match Plan ${plan.id}`);
      }
      yield* hardWrite(() =>
        sqlClient.withTransaction(
          Effect.gen(function* () {
            yield* db.insert(runs).values(runValues(record)).run();
            yield* db
              .insert(runPlans)
              .values({ runId: record.id, plan: encodeRunPlan(plan) })
              .run();
          }),
        ),
      );
      yield* RunLedger.logRunAccepted(record);
    }),

    getRunPlan: (runId: RunId) =>
      readRows("getRunPlan", () =>
        db.select({ plan: runPlans.plan }).from(runPlans).where(eq(runPlans.runId, runId)).limit(1).all(),
      ).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed(null);
          return decodeOrElse("getRunPlan", runId, decodeRunPlan(row.plan), null);
        }),
      ),

    insertRun: (record: RunRecord) => {
      const values = runValues(record);
      return write("insertRun", () =>
        db.insert(runs).values(values).onConflictDoUpdate({ target: runs.id, set: values }).run(),
      );
    },

    updateRun: Effect.fn("RunLedger.updateRun")(function* (runId: RunId, patch: RunLedger.RunUpdate) {
      const runIds = yield* writeIds("updateRun", () =>
        db.update(runs).set(runColumns(patch)).where(eq(runs.id, runId)).returning({ id: runs.id }).all(),
      );
      yield* RunLedger.logRunsSettled(runIds, patch.status);
    }),

    setRunSession: (runId: RunId, session: SessionId) =>
      write("setRunSession", () => db.update(runs).set({ session }).where(eq(runs.id, runId)).run()),

    interruptRunning: Effect.fn("RunLedger.interruptRunning")(function* (
      startedFromMillis: number,
      endedAtMillis: number,
    ) {
      const runIds = yield* writeIds("interruptRunning", () =>
        db
          .update(runs)
          .set({ status: "interrupted", endedAt: endedAtMillis })
          .where(and(eq(runs.status, "running"), gte(runs.startedAt, startedFromMillis)))
          .returning({ id: runs.id })
          .all(),
      );
      yield* RunLedger.logRunsSettled(runIds, "interrupted");
      return runIds;
    }),

    interruptRunningBefore: Effect.fn("RunLedger.interruptRunningBefore")(function* (
      beforeMillis: number,
      endedAtMillis: number,
    ) {
      const runIds = yield* writeIds("interruptRunningBefore", () =>
        db
          .update(runs)
          .set({ status: "interrupted", endedAt: endedAtMillis })
          .where(and(eq(runs.status, "running"), lt(runs.startedAt, beforeMillis)))
          .returning({ id: runs.id })
          .all(),
      );
      yield* RunLedger.logRunsSettled(runIds, "interrupted");
      return runIds;
    }),

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
            ? decodeOrElse("getSession", row.id, decodeSession(sessionFromRow(row)), null)
            : Effect.succeed(null),
        ),
      ),

    recordSessionHandle: (id, handle: string) =>
      write("recordSessionHandle", () =>
        db.update(sessions).set({ handle }).where(eq(sessions.id, id)).run(),
      ),

    sessionForBranch: (workspace: WorkspaceId, branch: BranchName) =>
      readRows("sessionForBranch", () =>
        db
          .select({ id: runs.id, session: runs.session })
          .from(runs)
          .where(and(eq(runs.workspace, workspace), eq(runs.branch, branch), isNotNull(runs.session)))
          .orderBy(desc(runs.startedAt), desc(sql<number>`"runs".rowid`))
          .limit(1)
          .all(),
      ).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row || row.session === null) return Effect.succeed(null);
          return decodeOrElse("sessionForBranch", row.id, decodeSessionId(row.session), null);
        }),
      ),

    sessionEvents: (session) =>
      readRows("sessionEvents", () =>
        db
          .select({
            runId: runs.id,
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
            "sessionEvents",
            decodeEvent,
            rows.map((row) => ({
              rowId: `${row.runId}:${row.seq}`,
              value: {
                seq: row.seq,
                type: row.type,
                name: row.name,
                data: row.data,
                atMillis: row.at,
              },
            })),
          ),
        ),
      ),

    closeRunning: Effect.fn("RunLedger.closeRunning")(function* (
      workspace: WorkspaceId,
      workItem: WorkItemId,
      endedAtMillis: number,
    ) {
      const runIds = yield* writeIds("closeRunning", () =>
        db
          .update(runs)
          .set({ status: "failed", endedAt: endedAtMillis })
          .where(and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")))
          .returning({ id: runs.id })
          .all(),
      );
      yield* RunLedger.logRunsSettled(runIds, "failed");
      return runIds;
    }),

    crashRunning: Effect.fn("RunLedger.crashRunning")(function* (
      workspace: WorkspaceId,
      workItem: WorkItemId,
      endedAtMillis: number,
    ) {
      const runIds = yield* writeIds("crashRunning", () =>
        db
          .update(runs)
          .set({ status: "crashed", endedAt: endedAtMillis })
          .where(and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")))
          .returning({ id: runs.id })
          .all(),
      );
      yield* RunLedger.logRunsSettled(runIds, "crashed");
      return runIds;
    }),

    consecutiveCrashes: (workspace: WorkspaceId, workItem: WorkItemId, sinceMillis: number) =>
      readRows("consecutiveCrashes", () =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(runs)
          .where(
            and(
              eq(runs.workspace, workspace),
              eq(runs.workItem, workItem),
              eq(runs.status, "crashed"),
              gt(runs.startedAt, sinceMillis),
              gt(
                runs.startedAt,
                sql<number>`coalesce((select max(${runs.startedAt}) from ${runs} where ${runs.workspace} = ${workspace} and ${runs.workItem} = ${workItem} and ${runs.status} <> 'crashed'), -1)`,
              ),
            ),
          )
          .all(),
      ).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0))),

    appendEvent: Effect.fn("RunLedger.appendEvent")(function* (runId: RunId, event: RunEvent) {
      const values = {
        runId,
        seq: event.seq,
        type: event.type,
        name: event.name,
        data: event.data,
        at: event.atMillis,
      };
      yield* write("appendEvent", () =>
        sqlClient
          .withTransaction(
            Effect.gen(function* () {
              const inserted = yield* db
                .insert(runEvents)
                .values(values)
                .onConflictDoNothing()
                .returning({ seq: runEvents.seq })
                .all();
              if (inserted.length === 0) {
                yield* db
                  .update(runEvents)
                  .set(values)
                  .where(and(eq(runEvents.runId, runId), eq(runEvents.seq, event.seq)))
                  .run();
                return;
              }
              yield* db
                .update(runs)
                .set({ eventCount: sql`${runs.eventCount} + 1` })
                .where(eq(runs.id, runId))
                .run();
            }),
          )
          .pipe(
            Effect.trackDuration(runLedgerAppendDuration),
            Effect.tap(() => RunLedger.logRunEventAppended(event)),
          ),
      );
    }),

    latestSeq: (runId: RunId) =>
      hardOperation(RunLedger.readRunEventsOperation, () =>
        db
          .select({ seq: sql<number | null>`max(${runEvents.seq})` })
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .all(),
      ).pipe(Effect.map((rows) => rows[0]?.seq ?? null)),

    latestRunByBranch: (workspace: WorkspaceId, branch: BranchName) =>
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

    latestRunForItem: (workspace: WorkspaceId, workItem: WorkItemId) =>
      latestRunWhere("latestRunForItem", and(eq(runs.workspace, workspace), eq(runs.workItem, workItem))),

    resolveWatchTarget: (workItem: WorkItemId) =>
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
        db.select(runSummarySelection).from(runs).orderBy(desc(runs.startedAt)).limit(limit).all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeAll(
            "listRuns",
            decodeSummary,
            rows.map((row) => ({
              rowId: row.id,
              value: runSummaryFromRow(row),
            })),
          ),
        ),
      ),

    runningRuns: readRows("runningRuns", () =>
      db
        .select(runSummarySelection)
        .from(runs)
        .where(eq(runs.status, "running"))
        .orderBy(desc(runs.startedAt))
        .all(),
    ).pipe(
      Effect.flatMap((rows) =>
        decodeAll(
          "runningRuns",
          decodeSummary,
          rows.map((row) => ({
            rowId: row.id,
            value: runSummaryFromRow(row),
          })),
        ),
      ),
    ),

    getRun: (runId: RunId) =>
      readRun("getRun", () => db.select(runRecordSelection).from(runs).where(eq(runs.id, runId)).get()),

    getRunSummary: (runId: RunId) =>
      readRunSummary("getRunSummary", () =>
        db.select(runSummarySelection).from(runs).where(eq(runs.id, runId)).get(),
      ),

    events: (runId: RunId) => Stream.paginate(-1, (afterSeq) => readEventPage(runId, afterSeq)),
  };

  return service;
});

export const layer = Layer.effect(RunLedger.CoreRunLedger, make());
