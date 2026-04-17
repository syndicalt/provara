CREATE TABLE `shares` (
	`token` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`tenant_id` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
