CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tenant` text NOT NULL,
	`hashed_token` text NOT NULL,
	`token_prefix` text NOT NULL,
	`rate_limit` integer,
	`spend_limit` real,
	`spend_period` text DEFAULT 'monthly',
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hashed_token_unique` ON `api_tokens` (`hashed_token`);--> statement-breakpoint
ALTER TABLE `cost_logs` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `tenant_id` text;