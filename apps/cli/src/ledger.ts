import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunId, RunRecord, TokenUsage } from "@clanker-forge/contracts";
import {
  RunEvent as RunEventSchema,
  RunSummary as RunSummarySchema,
  SessionId,
} from "@clanker-forge/contracts";
import { RunLedger } from "@clanker-forge/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  work_item TEXT NOT NULL,
  stage TEXT NOT NULL,
  harness TEXT NOT NULL,
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

interface RunRow {
  readonly id: string;
  readonly workspace: string;
  readonly work_item: string;
  readonly stage: string;
  readonly harness: string;
  readonly session: string | null;
  readonly input_tokens: number | bigint | null;
  readonly output_tokens: number | bigint | null;
  readonly total_tokens: number | bigint | null;
  readonly status: string;
  readonly started_at: number | bigint;
  readonly ended_at: number | bigint | null;
  readonly event_count: number | bigint;
}

interface EventRow {
  readonly seq: number | bigint;
  readonly type: string;
  readonly name: string | null;
  readonly data: string;
  readonly at: number | bigint;
}

const nullableInt = (value: number | bigint | null) => (value === null ? null : Number(value));

const usageColumns = (usage: TokenUsage | null) => ({
  input: usage?.inputTokens ?? null,
  output: usage?.outputTokens ?? null,
  total: usage?.totalTokens ?? null,
});

const usageOf = (row: RunRow): TokenUsage | null => {
  const input = nullableInt(row.input_tokens);
  const output = nullableInt(row.output_tokens);
  const total = nullableInt(row.total_tokens);
  if (input === null && output === null && total === null) return null;
  return {
    ...(input === null ? {} : { inputTokens: input }),
    ...(output === null ? {} : { outputTokens: output }),
    ...(total === null ? {} : { totalTokens: total }),
  };
};

const summaryOf = (row: RunRow) => ({
  id: row.id,
  workspace: row.workspace,
  workItem: row.work_item,
  stage: row.stage,
  harness: row.harness,
  session: row.session,
  usage: usageOf(row),
  status: row.status,
  startedAtMillis: Number(row.started_at),
  endedAtMillis: nullableInt(row.ended_at),
  eventCount: Number(row.event_count),
});

const eventOf = (row: EventRow) => ({
  seq: Number(row.seq),
  type: row.type,
  name: row.name,
  data: row.data,
  atMillis: Number(row.at),
});

const decodeSummary = Schema.decodeUnknownEffect(RunSummarySchema);
const decodeEvent = Schema.decodeUnknownEffect(RunEventSchema);
const decodeSession = Schema.decodeUnknownEffect(SessionId);

const decodeAll = <A, R>(
  decode: (u: unknown) => Effect.Effect<A, unknown, R>,
  rows: ReadonlyArray<unknown>,
) =>
  Effect.forEach(rows, (row) =>
    decode(row).pipe(
      Effect.map((value) => [value] as const),
      Effect.orElseSucceed(() => [] as const),
    ),
  ).pipe(Effect.map((chunks) => chunks.flat()));

const open = (ledgerPath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      const db = new DatabaseSync(ledgerPath);
      db.exec(schema);
      return db;
    }),
    (db) => Effect.sync(() => db.close()),
  );

const make = (ledgerPath: string) =>
  Effect.gen(function* () {
    const db = yield* open(ledgerPath);

    const insert = db.prepare(
      `INSERT OR REPLACE INTO runs
        (id, workspace, work_item, stage, harness, session, input_tokens, output_tokens, total_tokens, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE runs SET status = ?, session = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, ended_at = ?
       WHERE id = ?`,
    );
    const appendEvent = db.prepare(
      `INSERT OR REPLACE INTO run_events (run_id, seq, type, name, data, at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const selectRuns = db.prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM run_events e WHERE e.run_id = r.id) AS event_count
       FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
    );
    const selectEvents = db.prepare(
      `SELECT seq, type, name, data, at FROM run_events WHERE run_id = ? ORDER BY seq ASC`,
    );
    const selectSession = db.prepare(
      `SELECT session FROM runs WHERE work_item = ? AND session IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
    );

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

    const service: RunLedger.RunLedgerService = {
      insertRun: (record: RunRecord) =>
        write("insertRun", () => {
          const usage = usageColumns(record.usage);
          insert.run(
            record.id,
            record.workspace,
            record.workItem,
            record.stage,
            record.harness,
            record.session,
            usage.input,
            usage.output,
            usage.total,
            record.status,
            record.startedAtMillis,
            record.endedAtMillis,
          );
        }),

      updateRun: (runId: RunId, patch: RunLedger.RunUpdate) =>
        write("updateRun", () => {
          const usage = usageColumns(patch.usage);
          update.run(
            patch.status,
            patch.session,
            usage.input,
            usage.output,
            usage.total,
            patch.endedAtMillis,
            runId,
          );
        }),

      appendEvent: (runId: RunId, event: RunEvent) =>
        write("appendEvent", () => {
          appendEvent.run(runId, event.seq, event.type, event.name, event.data, event.atMillis);
        }),

      latestSession: (workItem: string) =>
        Effect.try(() => selectSession.get(workItem) as { readonly session: string } | undefined).pipe(
          Effect.tapError((cause) => warn("latestSession", cause)),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((row) =>
            row?.session
              ? decodeSession(row.session).pipe(Effect.orElseSucceed(() => null))
              : Effect.succeed(null),
          ),
        ),

      listRuns: (limit: number) =>
        readRows("listRuns", () => selectRuns.all(limit) as unknown as ReadonlyArray<RunRow>).pipe(
          Effect.flatMap((rows) => decodeAll(decodeSummary, rows.map(summaryOf))),
        ),

      events: (runId: RunId) =>
        readRows("events", () => selectEvents.all(runId) as unknown as ReadonlyArray<EventRow>).pipe(
          Effect.flatMap((rows) => decodeAll(decodeEvent, rows.map(eventOf))),
        ),
    };

    return service;
  });

export const layer = (ledgerPath: string) => Layer.effect(RunLedger.RunLedger, make(ledgerPath));
