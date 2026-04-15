ALTER TABLE `ab_tests` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `custom_providers` ADD `tenant_id` text;