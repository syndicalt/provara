CREATE TABLE `semantic_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`system_prompt_hash` text,
	`prompt_text` text NOT NULL,
	`embedding` blob NOT NULL,
	`embedding_dim` integer NOT NULL,
	`embedding_model` text NOT NULL,
	`response` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_hit_at` integer
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `cache_source` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `tokens_saved_input` integer;--> statement-breakpoint
ALTER TABLE `requests` ADD `tokens_saved_output` integer;