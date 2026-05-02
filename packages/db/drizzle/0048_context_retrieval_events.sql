CREATE TABLE `context_retrieval_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`optimization_event_id` text,
	`retrieved_chunks` integer NOT NULL,
	`used_chunks` integer NOT NULL,
	`unused_chunks` integer NOT NULL,
	`duplicate_chunks` integer NOT NULL,
	`risky_chunks` integer NOT NULL,
	`retrieved_tokens` integer NOT NULL,
	`used_tokens` integer NOT NULL,
	`unused_tokens` integer NOT NULL,
	`efficiency_pct` real NOT NULL,
	`duplicate_rate_pct` real NOT NULL,
	`risky_rate_pct` real NOT NULL,
	`used_source_ids` text DEFAULT '[]' NOT NULL,
	`unused_source_ids` text DEFAULT '[]' NOT NULL,
	`risky_source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_retrieval_events_tenant_created_idx` ON `context_retrieval_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `context_retrieval_events_optimization_idx` ON `context_retrieval_events` (`optimization_event_id`);
