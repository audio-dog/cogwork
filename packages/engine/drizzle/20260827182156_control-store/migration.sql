CREATE TABLE `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`data` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT `run_events_pk` PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
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
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`workspace` text NOT NULL,
	`harness` text NOT NULL,
	`kind` text NOT NULL,
	`handle` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_events_at` ON `run_events` (`at`);--> statement-breakpoint
CREATE INDEX `runs_started_at` ON `runs` ("started_at" desc);