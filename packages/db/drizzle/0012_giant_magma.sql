CREATE TABLE `model_scores` (
	`task_type` text NOT NULL,
	`complexity` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`quality_score` real NOT NULL,
	`sample_count` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_type`, `complexity`, `provider`, `model`)
);
