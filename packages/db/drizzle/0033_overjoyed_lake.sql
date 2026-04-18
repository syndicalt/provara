CREATE TABLE `spend_budgets` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`period` text DEFAULT 'monthly' NOT NULL,
	`cap_usd` real NOT NULL,
	`alert_thresholds` text NOT NULL,
	`alert_emails` text NOT NULL,
	`hard_stop` integer DEFAULT false NOT NULL,
	`alerted_thresholds` text NOT NULL,
	`period_started_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
