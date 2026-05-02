ALTER TABLE `context_collections` ADD `canonical_block_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_collections` ADD `approved_block_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `context_canonical_blocks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `collection_id` text NOT NULL,
  `content` text NOT NULL,
  `content_hash` text NOT NULL,
  `token_count` integer NOT NULL,
  `source_block_ids` text DEFAULT '[]' NOT NULL,
  `source_document_ids` text DEFAULT '[]' NOT NULL,
  `source_count` integer DEFAULT 0 NOT NULL,
  `review_status` text DEFAULT 'draft' NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `context_collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_canonical_blocks_tenant_collection_idx` ON `context_canonical_blocks` (`tenant_id`,`collection_id`);
--> statement-breakpoint
CREATE INDEX `context_canonical_blocks_review_idx` ON `context_canonical_blocks` (`tenant_id`,`collection_id`,`review_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_canonical_blocks_collection_hash_idx` ON `context_canonical_blocks` (`collection_id`,`content_hash`);
