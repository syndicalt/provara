CREATE TABLE `regression_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`task_type` text NOT NULL,
	`complexity` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`replay_count` integer NOT NULL,
	`original_mean` real NOT NULL,
	`replay_mean` real NOT NULL,
	`delta` real NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`detected_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution_note` text
);
--> statement-breakpoint
CREATE TABLE `replay_bank` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`task_type` text NOT NULL,
	`complexity` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`response` text NOT NULL,
	`original_score` real NOT NULL,
	`original_score_source` text NOT NULL,
	`source_request_id` text,
	`embedding` blob,
	`embedding_dim` integer,
	`embedding_model` text,
	`last_replayed_at` integer,
	`created_at` integer NOT NULL
);
