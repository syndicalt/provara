CREATE TABLE `context_collections` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `name` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'active' NOT NULL,
  `document_count` integer DEFAULT 0 NOT NULL,
  `block_count` integer DEFAULT 0 NOT NULL,
  `token_count` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_collections_tenant_updated_idx` ON `context_collections` (`tenant_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_collections_tenant_name_idx` ON `context_collections` (`tenant_id`,`name`);
--> statement-breakpoint
CREATE TABLE `context_documents` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `collection_id` text NOT NULL,
  `title` text NOT NULL,
  `source` text,
  `source_uri` text,
  `content_hash` text NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `block_count` integer NOT NULL,
  `token_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `context_collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_documents_tenant_collection_idx` ON `context_documents` (`tenant_id`,`collection_id`);
--> statement-breakpoint
CREATE INDEX `context_documents_hash_idx` ON `context_documents` (`content_hash`);
--> statement-breakpoint
CREATE TABLE `context_blocks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `collection_id` text NOT NULL,
  `document_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `content` text NOT NULL,
  `content_hash` text NOT NULL,
  `token_count` integer NOT NULL,
  `source` text,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `context_collections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`document_id`) REFERENCES `context_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_blocks_tenant_collection_idx` ON `context_blocks` (`tenant_id`,`collection_id`);
--> statement-breakpoint
CREATE INDEX `context_blocks_document_ordinal_idx` ON `context_blocks` (`document_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_blocks_document_ordinal_unique_idx` ON `context_blocks` (`document_id`,`ordinal`);
