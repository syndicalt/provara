ALTER TABLE `context_optimization_events` ADD `compressed_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `compression_saved_tokens` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `compression_rate_pct` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `compressed_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `compression_saved_tokens` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `compression_rate_pct` real DEFAULT 0 NOT NULL;
