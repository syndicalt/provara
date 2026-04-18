CREATE TABLE `adaptive_isolation_preferences_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`field` text NOT NULL,
	`old_value` integer NOT NULL,
	`new_value` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_adaptive_isolation` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`consumes_pool` integer DEFAULT false NOT NULL,
	`contributes_pool` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
