CREATE TABLE `context_optimization_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`input_chunks` integer NOT NULL,
	`output_chunks` integer NOT NULL,
	`dropped_chunks` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`saved_tokens` integer NOT NULL,
	`reduction_pct` real NOT NULL,
	`duplicate_source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_optimization_events_tenant_created_idx` ON `context_optimization_events` (`tenant_id`,`created_at`);
