CREATE TABLE `sso_configs` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`idp_entity_id` text NOT NULL,
	`idp_sso_url` text NOT NULL,
	`idp_cert` text NOT NULL,
	`sp_entity_id` text NOT NULL,
	`email_domains` text NOT NULL,
	`require_encryption` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
