CREATE TABLE `guardrail_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`tenant_id` text,
	`rule_id` text,
	`rule_name` text NOT NULL,
	`target` text NOT NULL,
	`action` text NOT NULL,
	`matched_content` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `guardrail_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `guardrail_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target` text DEFAULT 'both' NOT NULL,
	`action` text DEFAULT 'block' NOT NULL,
	`pattern` text,
	`enabled` integer DEFAULT true NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
