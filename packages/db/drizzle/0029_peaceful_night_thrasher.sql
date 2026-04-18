CREATE TABLE `magic_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`pending_first_name` text,
	`pending_last_name` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `magic_link_tokens_email_idx` ON `magic_link_tokens` (`email`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_hash_idx` ON `magic_link_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `users` ADD `first_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_name` text;--> statement-breakpoint
-- Backfill split names from legacy `name` column. Split on the first
-- space: `last_name` = trailing token, `first_name` = everything before.
-- Rows with a single token (e.g. one-word display names from GitHub)
-- get it all in `first_name` and `last_name` stays NULL.
UPDATE `users`
  SET `first_name` = CASE
    WHEN instr(`name`, ' ') > 0 THEN substr(`name`, 1, instr(`name`, ' ') - 1)
    ELSE `name`
  END,
  `last_name` = CASE
    WHEN instr(`name`, ' ') > 0 THEN substr(`name`, instr(`name`, ' ') + 1)
    ELSE NULL
  END
  WHERE `name` IS NOT NULL AND `first_name` IS NULL AND `last_name` IS NULL;