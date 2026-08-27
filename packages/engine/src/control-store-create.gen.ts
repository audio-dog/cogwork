// Generated from src/control-store-schema.ts by scripts/generate-control-store-create.mjs.
// Do not edit by hand: run `pnpm --filter @cogwork/engine drizzle:schema`.
export const createStatements: ReadonlyArray<string> = [
  "CREATE TABLE `daemon_limits` (\n\t`id` integer PRIMARY KEY,\n\t`global_concurrency` integer NOT NULL,\n\t`per_workspace_concurrency` integer NOT NULL,\n\t`daily_budget` integer NOT NULL,\n\t`revision` integer NOT NULL,\n\tCONSTRAINT \"daemon_limits_single_row\" CHECK(\"id\" = 1),\n\tCONSTRAINT \"daemon_limits_global_concurrency\" CHECK(\"global_concurrency\" BETWEEN 1 AND 1000),\n\tCONSTRAINT \"daemon_limits_per_workspace_concurrency\" CHECK(\"per_workspace_concurrency\" BETWEEN 1 AND 1000),\n\tCONSTRAINT \"daemon_limits_daily_budget\" CHECK(\"daily_budget\" BETWEEN 1 AND 1000),\n\tCONSTRAINT \"daemon_limits_revision\" CHECK(\"revision\" >= 0)\n);",
  "CREATE TABLE `run_events` (\n\t`run_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`name` text,\n\t`data` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)\n);",
  "CREATE TABLE `runs` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`work_item` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`branch` text,\n\t`session` text,\n\t`input_tokens` integer,\n\t`output_tokens` integer,\n\t`total_tokens` integer,\n\t`estimated` integer,\n\t`status` text NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`ended_at` integer\n);",
  "CREATE TABLE `sessions` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`handle` text,\n\t`created_at` integer NOT NULL\n);",
  "CREATE INDEX `run_events_at` ON `run_events` (`at`);",
  "CREATE INDEX `runs_started_at` ON `runs` (\"started_at\" desc);",
];
