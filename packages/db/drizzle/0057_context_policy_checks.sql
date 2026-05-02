ALTER TABLE `context_canonical_blocks` ADD `policy_status` text DEFAULT 'unchecked' NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_canonical_blocks` ADD `policy_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `context_canonical_blocks` ADD `policy_details` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE INDEX `context_canonical_blocks_policy_idx` ON `context_canonical_blocks` (`tenant_id`,`collection_id`,`policy_status`);
