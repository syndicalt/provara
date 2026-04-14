CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`tenant_id` text,
	`score` integer NOT NULL,
	`comment` text,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `routing_profile` text DEFAULT 'balanced';