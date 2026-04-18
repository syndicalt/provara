PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_scores` (
	`tenant_id` text DEFAULT '' NOT NULL,
	`task_type` text NOT NULL,
	`complexity` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`quality_score` real NOT NULL,
	`sample_count` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `task_type`, `complexity`, `provider`, `model`)
);
--> statement-breakpoint
INSERT INTO `__new_model_scores`("task_type", "complexity", "provider", "model", "quality_score", "sample_count", "updated_at") SELECT "task_type", "complexity", "provider", "model", "quality_score", "sample_count", "updated_at" FROM `model_scores`;--> statement-breakpoint
DROP TABLE `model_scores`;--> statement-breakpoint
ALTER TABLE `__new_model_scores` RENAME TO `model_scores`;--> statement-breakpoint
PRAGMA foreign_keys=ON;