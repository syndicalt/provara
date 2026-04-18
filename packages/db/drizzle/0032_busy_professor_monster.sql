ALTER TABLE `cost_logs` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `cost_logs` ADD `api_token_id` text;--> statement-breakpoint
CREATE INDEX `cost_logs_tenant_user_created_idx` ON `cost_logs` (`tenant_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cost_logs_tenant_token_created_idx` ON `cost_logs` (`tenant_id`,`api_token_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `requests` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `api_token_id` text;