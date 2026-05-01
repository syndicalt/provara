CREATE TABLE `firewall_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`request_id` text,
	`surface` text NOT NULL,
	`source` text,
	`mode` text,
	`decision` text NOT NULL,
	`action` text NOT NULL,
	`passed` integer NOT NULL,
	`confidence` real,
	`risk_level` text,
	`category` text,
	`tool_name` text,
	`rule_name` text,
	`matched_content` text,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `firewall_events_tenant_created_idx` ON `firewall_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `firewall_events_request_idx` ON `firewall_events` (`request_id`);
