ALTER TABLE `context_canonical_blocks` ADD `review_note` text;
--> statement-breakpoint
ALTER TABLE `context_canonical_blocks` ADD `reviewed_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `context_canonical_blocks` ADD `reviewed_at` integer;
--> statement-breakpoint
CREATE TABLE `context_canonical_review_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `collection_id` text NOT NULL,
  `canonical_block_id` text NOT NULL,
  `from_status` text NOT NULL,
  `to_status` text NOT NULL,
  `note` text,
  `actor_user_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `context_collections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`canonical_block_id`) REFERENCES `context_canonical_blocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_canonical_review_events_tenant_created_idx` ON `context_canonical_review_events` (`tenant_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `context_canonical_review_events_block_idx` ON `context_canonical_review_events` (`canonical_block_id`,`created_at`);
