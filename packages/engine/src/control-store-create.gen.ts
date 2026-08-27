// Generated from src/control-store-schema.ts by scripts/generate-control-store-create.mjs.
// Do not edit by hand: run `pnpm --filter @cogwork/engine drizzle:schema`.
export const createStatements: ReadonlyArray<string> = [
  "CREATE TABLE `run_events` (\n\t`run_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`name` text,\n\t`data` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)\n);",
  "CREATE TABLE `runs` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`work_item` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`branch` text,\n\t`session` text,\n\t`input_tokens` integer,\n\t`output_tokens` integer,\n\t`total_tokens` integer,\n\t`estimated` integer,\n\t`status` text NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`ended_at` integer\n);",
  "CREATE TABLE `sessions` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`handle` text,\n\t`created_at` integer NOT NULL\n);",
  "CREATE TABLE `workspaces` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`checkout_path` text NOT NULL UNIQUE,\n\t`git_remote` text,\n\t`issue_tracker` text NOT NULL,\n\t`source_control` text,\n\t`linear_history` integer NOT NULL,\n\t`worktree_root` text,\n\t`worktree_remote` text,\n\t`worktree_base_branch` text,\n\t`worktree_reap_after_millis` integer,\n\t`concurrency` integer\n);",
  "CREATE INDEX `run_events_at` ON `run_events` (`at`);",
  "CREATE INDEX `runs_started_at` ON `runs` (\"started_at\" desc);",
];
