ALTER TABLE `context_optimization_events` ADD `avg_freshness_score` real;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `stale_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `avg_freshness_score` real;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `stale_chunks` integer DEFAULT 0 NOT NULL;
