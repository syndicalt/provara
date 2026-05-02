CREATE TABLE `context_quality_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`raw_score` real NOT NULL,
	`optimized_score` real NOT NULL,
	`delta` real NOT NULL,
	`regressed` integer DEFAULT 0 NOT NULL,
	`regression_threshold` real NOT NULL,
	`judge_provider` text NOT NULL,
	`judge_model` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`raw_source_ids` text DEFAULT '[]' NOT NULL,
	`optimized_source_ids` text DEFAULT '[]' NOT NULL,
	`rationale` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_quality_events_tenant_created_idx` ON `context_quality_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `context_quality_events_tenant_regressed_idx` ON `context_quality_events` (`tenant_id`,`regressed`,`created_at`);
