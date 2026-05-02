ALTER TABLE `context_optimization_events` ADD `conflict_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `conflict_groups` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `conflict_source_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `conflict_details` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `conflict_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `conflict_groups` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `conflict_rate_pct` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `conflict_source_ids` text DEFAULT '[]' NOT NULL;
