import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunId, RunRecord, TokenUsage } from "@clanker-forge/contracts";
import {
  RunEvent as RunEventSchema,
  RunRecord as RunRecordSchema,
  RunSummary as RunSummarySchema,
} from "@clanker-forge/contracts";
import { RunLedger } from "@clanker-forge/engine";
import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { runEvents, runs } from "./schema";

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
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
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

const runColumns = (record: {
  readonly session: string | null;
  readonly usage: TokenUsage | null;
  readonly status: string;
  readonly endedAtMillis: number | null;
}) => ({
  session: record.session,
  inputTokens: record.usage?.inputTokens ?? null,
  outputTokens: record.usage?.outputTokens ?? null,
  totalTokens: record.usage?.totalTokens ?? null,
  status: record.status,
  endedAt: record.endedAtMillis,
});

const usageOf = (row: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}): TokenUsage | null => {
  if (row.inputTokens === null && row.outputTokens === null && row.totalTokens === null) return null;
  return {
    ...(row.inputTokens === null ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === null ? {} : { outputTokens: row.outputTokens }),
    ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
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
const decodeEvent = Schema.decodeUnknownEffect(RunEventSchema);
const decodeRun = Schema.decodeUnknownEffect(RunRecordSchema);

const decodeAll = <A, E, R>(decode: (u: unknown) => Effect.Effect<A, E, R>, rows: ReadonlyArray<unknown>) =>
  Effect.forEach(rows, (row) =>
    decode(row).pipe(
      Effect.map((value) => [value] as const),
      Effect.orElseSucceed(() => [] as const),
    ),
  ).pipe(Effect.map((chunks) => chunks.flat()));

const ensureBranchColumn = (sqlite: DatabaseSync) => {
  try {
    sqlite.exec("ALTER TABLE runs ADD COLUMN branch TEXT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column")) throw error;
  }
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
        ensureBranchColumn(sqlite);
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

    const latestRunWhere = (operation: string, where: SQL | undefined) =>
      Effect.try(() =>
        db
          .select(runRecordSelection)
          .from(runs)
          .where(and(where, isNotNull(runs.session)))
          .orderBy(desc(runs.startedAt))
          .limit(1)
          .get(),
      ).pipe(
        Effect.tapError((cause) => warn(operation, cause)),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((row) =>
          row
            ? decodeRun(runRecordFromRow(row)).pipe(Effect.orElseSucceed(() => null))
            : Effect.succeed(null),
        ),
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
            startedAt: record.startedAtMillis,
            ...runColumns(record),
          };
          db.insert(runs).values(values).onConflictDoUpdate({ target: runs.id, set: values }).run();
        }),

      updateRun: (runId: RunId, patch: RunLedger.RunUpdate) =>
        write("updateRun", () => {
          db.update(runs).set(runColumns(patch)).where(eq(runs.id, runId)).run();
        }),

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
        latestRunWhere("latestRunByBranch", and(eq(runs.workspace, workspace), eq(runs.branch, branch))),

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

export const layer = (ledgerPath: string) => Layer.effect(RunLedger.RunLedger, make(ledgerPath));
