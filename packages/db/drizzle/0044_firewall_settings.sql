CREATE TABLE `firewall_settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`default_scan_mode` text DEFAULT 'signature' NOT NULL,
	`tool_call_alignment` text DEFAULT 'block' NOT NULL,
	`streaming_enforcement` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
