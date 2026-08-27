export interface Migration {
  readonly id: number;
  readonly hash: string;
  readonly statements: ReadonlyArray<string>;
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: 0,
    hash: "a9e922adee4d86f8c5887354e801e37ae8caf3e38350a813da67af2b4927a589",
    statements: [
      "CREATE TABLE IF NOT EXISTS `authoritative_records` (\n\t`key` text PRIMARY KEY,\n\t`value` text NOT NULL,\n\t`revision` integer NOT NULL\n)",
      "--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS `control_migrations` (\n\t`id` integer PRIMARY KEY,\n\t`hash` text NOT NULL\n)",
      "--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS `run_events` (\n\t`run_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`name` text,\n\t`data` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)\n)",
      "--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS `runs` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`work_item` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`branch` text,\n\t`session` text,\n\t`input_tokens` integer,\n\t`output_tokens` integer,\n\t`total_tokens` integer,\n\t`estimated` integer,\n\t`status` text NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`ended_at` integer\n)",
      "--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS `sessions` (\n\t`id` text PRIMARY KEY,\n\t`workspace` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`handle` text,\n\t`created_at` integer NOT NULL\n)",
      "--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS `runs_started_at` ON `runs` (`started_at` DESC)",
      "--> statement-breakpoint\nUPDATE `runs` SET `status` = 'exhausted' WHERE `status` = 'blocked'",
    ],
  },
  {
    id: 1,
    hash: "94e37a9db6f27c1c8ed92ddbd2669b2668d5fdf28e40326a0ee630a02f17d119",
    statements: ["CREATE INDEX IF NOT EXISTS `run_events_at` ON `run_events` (`at`)"],
  },
];
