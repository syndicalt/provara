CREATE TABLE `ab_test_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`ab_test_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`task_type` text,
	`complexity` text,
	FOREIGN KEY (`ab_test_id`) REFERENCES `ab_tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ab_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cost_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`response` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer,
	`cost` real,
	`task_type` text,
	`complexity` text,
	`routed_by` text,
	`ab_test_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ab_test_id`) REFERENCES `ab_tests`(`id`) ON UPDATE no action ON DELETE no action
);
