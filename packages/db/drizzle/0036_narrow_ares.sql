DROP INDEX "api_tokens_hashed_token_unique";--> statement-breakpoint
DROP INDEX "audit_logs_tenant_created_idx";--> statement-breakpoint
DROP INDEX "audit_logs_tenant_action_created_idx";--> statement-breakpoint
DROP INDEX "cost_logs_tenant_user_created_idx";--> statement-breakpoint
DROP INDEX "cost_logs_tenant_token_created_idx";--> statement-breakpoint
DROP INDEX "custom_providers_name_unique";--> statement-breakpoint
DROP INDEX "magic_link_tokens_email_idx";--> statement-breakpoint
DROP INDEX "magic_link_tokens_hash_idx";--> statement-breakpoint
DROP INDEX "oauth_provider_account_idx";--> statement-breakpoint
DROP INDEX "rws_tenant_captured_idx";--> statement-breakpoint
DROP INDEX "subscriptions_tenant_idx";--> statement-breakpoint
DROP INDEX "subscriptions_customer_idx";--> statement-breakpoint
DROP INDEX "team_invites_tenant_email_idx";--> statement-breakpoint
DROP INDEX "usage_reports_sub_period_idx";--> statement-breakpoint
DROP INDEX "usage_reports_tenant_period_idx";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE `team_invites` ALTER COLUMN "invited_role" TO "invited_role" text NOT NULL DEFAULT 'developer';--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hashed_token_unique` ON `api_tokens` (`hashed_token`);--> statement-breakpoint
CREATE INDEX `audit_logs_tenant_created_idx` ON `audit_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_tenant_action_created_idx` ON `audit_logs` (`tenant_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `cost_logs_tenant_user_created_idx` ON `cost_logs` (`tenant_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cost_logs_tenant_token_created_idx` ON `cost_logs` (`tenant_id`,`api_token_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `custom_providers_name_unique` ON `custom_providers` (`name`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_email_idx` ON `magic_link_tokens` (`email`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_hash_idx` ON `magic_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_provider_account_idx` ON `oauth_accounts` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE INDEX `rws_tenant_captured_idx` ON `routing_weight_snapshots` (`tenant_id`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_tenant_idx` ON `subscriptions` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_customer_idx` ON `subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_invites_tenant_email_idx` ON `team_invites` (`tenant_id`,`invited_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reports_sub_period_idx` ON `usage_reports` (`stripe_subscription_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reports_tenant_period_idx` ON `usage_reports` (`tenant_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `created_by_user_id` text REFERENCES users(id);--> statement-breakpoint
UPDATE `users` SET `role` = 'developer' WHERE `role` = 'member';--> statement-breakpoint
UPDATE `team_invites` SET `invited_role` = 'developer' WHERE `invited_role` = 'member';