CREATE TABLE `scheduled_jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_ms` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`last_duration_ms` integer,
	`run_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `auto_generated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `source_task_type` text;--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `source_complexity` text;--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `source_reason` text;--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `resolved_winner` text;--> statement-breakpoint
ALTER TABLE `ab_tests` ADD `resolved_at` integer;