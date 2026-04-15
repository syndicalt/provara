CREATE TABLE `alert_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`rule_name` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`threshold` real NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`metric` text NOT NULL,
	`condition` text DEFAULT 'gt' NOT NULL,
	`threshold` real NOT NULL,
	`window` text DEFAULT '1h' NOT NULL,
	`channel` text DEFAULT 'webhook' NOT NULL,
	`webhook_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL
);
