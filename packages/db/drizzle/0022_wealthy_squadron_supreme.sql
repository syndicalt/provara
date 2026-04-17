CREATE TABLE `cost_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`task_type` text NOT NULL,
	`complexity` text NOT NULL,
	`from_provider` text NOT NULL,
	`from_model` text NOT NULL,
	`from_cost_per_1m` real NOT NULL,
	`from_quality_score` real NOT NULL,
	`to_provider` text NOT NULL,
	`to_model` text NOT NULL,
	`to_cost_per_1m` real NOT NULL,
	`to_quality_score` real NOT NULL,
	`projected_monthly_savings_usd` real DEFAULT 0 NOT NULL,
	`grace_ends_at` integer NOT NULL,
	`executed_at` integer NOT NULL,
	`rolled_back_at` integer,
	`rollback_reason` text
);
