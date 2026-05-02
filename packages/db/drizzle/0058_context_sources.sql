CREATE TABLE `context_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `collection_id` text NOT NULL,
  `name` text NOT NULL,
  `type` text DEFAULT 'manual' NOT NULL,
  `external_id` text,
  `source_uri` text,
  `content` text DEFAULT '' NOT NULL,
  `content_hash` text NOT NULL,
  `sync_status` text DEFAULT 'pending' NOT NULL,
  `last_synced_at` integer,
  `last_document_id` text,
  `document_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `context_collections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`last_document_id`) REFERENCES `context_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_sources_tenant_collection_idx` ON `context_sources` (`tenant_id`,`collection_id`);
--> statement-breakpoint
CREATE INDEX `context_sources_sync_idx` ON `context_sources` (`tenant_id`,`sync_status`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_sources_collection_external_idx` ON `context_sources` (`collection_id`,`external_id`);
