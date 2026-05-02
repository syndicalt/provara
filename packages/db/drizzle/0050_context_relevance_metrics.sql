ALTER TABLE `context_optimization_events` ADD `avg_relevance_score` real;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `low_relevance_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `reranked_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `avg_relevance_score` real;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `low_relevance_chunks` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_retrieval_events` ADD `reranked_chunks` integer DEFAULT 0 NOT NULL;
