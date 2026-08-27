// Generated from packages/engine/drizzle by scripts/generate-control-store-migrations.mjs.
// Do not edit by hand: run `pnpm --filter @cogwork/engine drizzle:generate`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const apply = Effect.fn("ControlStore.applyMigration")(function* (statements: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

export const migrations = {
  "20260827182156_control-store": apply([
    "CREATE TABLE `run_events` (\n\t`run_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`name` text,\n\t`data` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)\n);",
    "CREATE TABLE `runs` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`work_item` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`branch` text,\n\t`session` text,\n\t`input_tokens` integer,\n\t`output_tokens` integer,\n\t`total_tokens` integer,\n\t`estimated` integer,\n\t`status` text NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`ended_at` integer\n);",
    "CREATE TABLE `sessions` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`handle` text,\n\t`created_at` integer NOT NULL\n);",
    "CREATE INDEX `run_events_at` ON `run_events` (`at`);",
    "CREATE INDEX `runs_started_at` ON `runs` (\"started_at\" desc);",
  ]),
};
