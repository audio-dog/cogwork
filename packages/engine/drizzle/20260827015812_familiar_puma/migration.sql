CREATE TABLE IF NOT EXISTS `authoritative_records` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `control_migrations` (
	`id` integer PRIMARY KEY,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`data` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runs` (
	`id` text PRIMARY KEY,
	`workspace` text NOT NULL,
	`work_item` text NOT NULL,
	`stage` text NOT NULL,
	`harness` text NOT NULL,
	`branch` text,
	`session` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`estimated` integer,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY,
	`workspace` text NOT NULL,
	`harness` text NOT NULL,
	`kind` text NOT NULL,
	`handle` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `runs_started_at` ON `runs` (`started_at` DESC);
--> statement-breakpoint
UPDATE `runs` SET `status` = 'exhausted' WHERE `status` = 'blocked';
