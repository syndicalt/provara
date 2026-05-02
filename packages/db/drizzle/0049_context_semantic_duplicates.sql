ALTER TABLE `context_optimization_events` ADD `near_duplicate_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `near_duplicate_source_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `near_duplicate_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `near_duplicate_rate_pct` real DEFAULT 0 NOT NULL;
