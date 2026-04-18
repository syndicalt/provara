CREATE TABLE `routing_weight_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`task_type` text DEFAULT '_all_' NOT NULL,
	`complexity` text DEFAULT '_all_' NOT NULL,
	`weights` text NOT NULL,
	`profile` text,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rws_tenant_captured_idx` ON `routing_weight_snapshots` (`tenant_id`,`captured_at`);