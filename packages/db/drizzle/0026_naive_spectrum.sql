CREATE TABLE `team_invites` (
	`token` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`invited_email` text NOT NULL,
	`invited_role` text DEFAULT 'member' NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`consumed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_invites_tenant_email_idx` ON `team_invites` (`tenant_id`,`invited_email`);