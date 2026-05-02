CREATE TABLE `context_connector_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `encrypted_value` text NOT NULL,
  `iv` text NOT NULL,
  `auth_tag` text NOT NULL,
  `last_used_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_connector_credentials_tenant_idx` ON `context_connector_credentials` (`tenant_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_connector_credentials_tenant_name_idx` ON `context_connector_credentials` (`tenant_id`,`name`);
