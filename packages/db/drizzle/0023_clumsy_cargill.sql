CREATE TABLE `stripe_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`processed_at` integer NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`stripe_subscription_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`stripe_product_id` text NOT NULL,
	`tier` text NOT NULL,
	`includes_intelligence` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`current_period_start` integer NOT NULL,
	`current_period_end` integer NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`trial_end` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_tenant_idx` ON `subscriptions` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_customer_idx` ON `subscriptions` (`stripe_customer_id`);