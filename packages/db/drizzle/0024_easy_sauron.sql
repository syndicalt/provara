CREATE TABLE `usage_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`reported_overage_count` integer DEFAULT 0 NOT NULL,
	`total_pushed_usd` real DEFAULT 0 NOT NULL,
	`reported_at` integer,
	`last_event_identifier` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reports_sub_period_idx` ON `usage_reports` (`stripe_subscription_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reports_tenant_period_idx` ON `usage_reports` (`tenant_id`,`period_start`);