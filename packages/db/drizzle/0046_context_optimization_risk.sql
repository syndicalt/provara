ALTER TABLE `context_optimization_events` ADD `risk_scanned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `flagged_chunks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `quarantined_chunks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `risky_source_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `context_optimization_events` ADD `risk_details` text DEFAULT '[]' NOT NULL;
