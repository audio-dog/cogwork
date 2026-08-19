import { DatabaseSync } from "node:sqlite";
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
import { RunLedger } from "@cogwork/engine";
import { and, desc, eq, gt, gte, inArray, isNotNull, lt, notInArray, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { runEvents, runs, sessions } from "./schema";

const bootstrapSql = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  work_item TEXT NOT NULL,
  stage TEXT NOT NULL,
  harness TEXT NOT NULL,
  branch TEXT,
  session TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  handle TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at DESC);
`;

const unresumableStatuses = ["interrupted", "crashed", "exhausted"];

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

const addColumnIfMissing = (sqlite: DatabaseSync, ddl: string) => {
  try {
    sqlite.exec(ddl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column")) throw error;
  }
};

const migrateBlockedToExhausted = (sqlite: DatabaseSync) => {
  sqlite.exec("UPDATE runs SET status = 'exhausted' WHERE status = 'blocked'");
};

const open = (ledgerPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(ledgerPath), { recursive: true });
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        const sqlite = new DatabaseSync(ledgerPath);
        sqlite.exec(bootstrapSql);
        addColumnIfMissing(sqlite, "ALTER TABLE runs ADD COLUMN branch TEXT");
        addColumnIfMissing(sqlite, "ALTER TABLE runs ADD COLUMN estimated INTEGER");
        migrateBlockedToExhausted(sqlite);
        return drizzle({ client: sqlite });
      }),
      (db) => Effect.sync(() => db.$client.close()),
    );
  });

const make = (ledgerPath: string) =>
  Effect.gen(function* () {
    const db = yield* open(ledgerPath);

    const warn = (operation: string, cause: unknown) =>
      Effect.logWarning(`run ledger ${operation} failed`, {
        cause: cause instanceof Error ? cause.message : String(cause),
      });

    const write = (operation: string, thunk: () => void) =>
      Effect.try(thunk).pipe(
        Effect.tapError((cause) => warn(operation, cause)),
        Effect.ignore,
      );

    const readRows = <A>(operation: string, thunk: () => ReadonlyArray<A>) =>
      Effect.try(thunk).pipe(
        Effect.tapError((cause) => warn(operation, cause)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<A>),
      );

    const writeIds = (operation: string, thunk: () => ReadonlyArray<{ readonly id: string }>) =>
      readRows(operation, thunk).pipe(
        Effect.flatMap((rows) =>
          decodeAll(
            decodeRunId,
            rows.map((row) => row.id),
          ),
        ),
      );

    const readRun = (operation: string, thunk: () => Parameters<typeof runRecordFromRow>[0] | undefined) =>
      Effect.try(thunk).pipe(
        Effect.tapError((cause) => warn(operation, cause)),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((row) =>
          row
            ? decodeRun(runRecordFromRow(row)).pipe(Effect.orElseSucceed(() => null))
            : Effect.succeed(null),
        ),
      );

    const latestRunWhere = (operation: string, where: SQL | undefined) =>
      readRun(operation, () =>
        db.select(runRecordSelection).from(runs).where(where).orderBy(desc(runs.startedAt)).limit(1).get(),
      );

    const service: RunLedger.RunLedgerService = {
      insertRun: (record: RunRecord) =>
        write("insertRun", () => {
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
          db.insert(runs).values(values).onConflictDoUpdate({ target: runs.id, set: values }).run();
        }),

      updateRun: (runId: RunId, patch: RunLedger.RunUpdate) =>
        write("updateRun", () => {
          db.update(runs).set(runColumns(patch)).where(eq(runs.id, runId)).run();
        }),

      interruptRunning: (startedFromMillis: number, endedAtMillis: number) =>
        writeIds("interruptRunning", () =>
          db
            .update(runs)
            .set({ status: "interrupted", endedAt: endedAtMillis })
            .where(and(eq(runs.status, "running"), gte(runs.startedAt, startedFromMillis)))
            .returning({ id: runs.id })
            .all(),
        ),

      interruptRunningBefore: (
        beforeMillis: number,
        endedAtMillis: number,
        held: ReadonlyArray<RunLedger.HeldRun> = [],
      ) => {
        const heldMatch =
          held.length === 0
            ? undefined
            : or(
                ...held.map((item) =>
                  and(eq(runs.workspace, item.workspace), eq(runs.workItem, item.workItem)),
                ),
              );
        return writeIds("interruptRunningBefore", () =>
          db
            .update(runs)
            .set({ status: "interrupted", endedAt: endedAtMillis })
            .where(
              and(
                eq(runs.status, "running"),
                lt(runs.startedAt, beforeMillis),
                heldMatch === undefined ? undefined : sql`not (${heldMatch})`,
              ),
            )
            .returning({ id: runs.id })
            .all(),
        );
      },

      insertSession: (session: Session) =>
        write("insertSession", () => {
          db.insert(sessions).values(sessionValues(session)).onConflictDoNothing().run();
        }),

      getSession: (id) =>
        Effect.try(() => db.select().from(sessions).where(eq(sessions.id, id)).get()).pipe(
          Effect.tapError((cause) => warn("getSession", cause)),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((row) =>
            row
              ? decodeSession(sessionFromRow(row)).pipe(Effect.orElseSucceed(() => null))
              : Effect.succeed(null),
          ),
        ),

      recordSessionHandle: (id, handle: string) =>
        write("recordSessionHandle", () => {
          db.update(sessions).set({ handle }).where(eq(sessions.id, id)).run();
        }),

      sessionForBranch: (workspace: string, branch: string) =>
        readRows("sessionForBranch", () =>
          db
            .select({ session: runs.session })
            .from(runs)
            .where(and(eq(runs.workspace, workspace), eq(runs.branch, branch), isNotNull(runs.session)))
            .orderBy(desc(runs.startedAt))
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
            .where(
              and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")),
            )
            .returning({ id: runs.id })
            .all(),
        ),

      crashRunning: (workspace: string, workItem: string, endedAtMillis: number) =>
        writeIds("crashRunning", () =>
          db
            .update(runs)
            .set({ status: "crashed", endedAt: endedAtMillis })
            .where(
              and(eq(runs.workspace, workspace), eq(runs.workItem, workItem), eq(runs.status, "running")),
            )
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

      consecutiveCrashesForRecovery: (workspace: string, workItem: string) =>
        readRows("consecutiveCrashesForRecovery", () =>
          db
            .select(runRecordSelection)
            .from(runs)
            .where(and(eq(runs.workspace, workspace), eq(runs.workItem, workItem)))
            .orderBy(runs.startedAt)
            .all(),
        ).pipe(
          Effect.flatMap((rows) =>
            decodeAll(decodeRun, rows.map(runRecordFromRow)).pipe(
              Effect.orElseSucceed(() => [] as ReadonlyArray<RunRecord>),
            ),
          ),
          Effect.map(RunLedger.consecutiveCrashesForRecoveryOf),
        ),

      appendEvent: (runId: RunId, event: RunEvent) =>
        write("appendEvent", () => {
          const values = {
            runId,
            seq: event.seq,
            type: event.type,
            name: event.name,
            data: event.data,
            at: event.atMillis,
          };
          db.insert(runEvents)
            .values(values)
            .onConflictDoUpdate({ target: [runEvents.runId, runEvents.seq], set: values })
            .run();
        }),

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
            .orderBy(desc(runs.startedAt))
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

export const layer = (ledgerPath: string) => Layer.effect(RunLedger.CoreRunLedger, make(ledgerPath));
