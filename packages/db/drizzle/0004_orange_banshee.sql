CREATE TABLE `custom_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_ref` text,
	`models` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_providers_name_unique` ON `custom_providers` (`name`);--> statement-breakpoint
CREATE TABLE `model_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_price_per_1m` real,
	`output_price_per_1m` real,
	`source` text DEFAULT 'builtin' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
