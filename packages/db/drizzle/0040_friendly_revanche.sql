CREATE TABLE `prompt_rollouts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`template_id` text NOT NULL,
	`canary_version_id` text NOT NULL,
	`stable_version_id` text NOT NULL,
	`rollout_pct` integer NOT NULL,
	`criteria` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`completion_reason` text,
	FOREIGN KEY (`template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canary_version_id`) REFERENCES `prompt_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stable_version_id`) REFERENCES `prompt_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `prompt_version_id` text;