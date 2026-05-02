import { createHash } from "node:crypto";
import type { Db } from "@provara/db";
import { contextBlocks, contextCollections, contextDocuments } from "@provara/db";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter, tenantScoped } from "../auth/tenant.js";
import { estimateContextTokens } from "./optimizer.js";

const MAX_COLLECTION_NAME_CHARS = 120;
const MAX_COLLECTION_DESCRIPTION_CHARS = 1_000;
const MAX_DOCUMENT_TITLE_CHARS = 200;
const MAX_SOURCE_CHARS = 120;
const MAX_SOURCE_URI_CHARS = 2_000;
const MAX_METADATA_CHARS = 20_000;
const MAX_INGEST_TEXT_CHARS = 500_000;
const TARGET_BLOCK_CHARS = 1_800;
const MIN_BOUNDARY_CHARS = 900;
const BLOCK_INSERT_BATCH_SIZE = 50;

export interface ContextCollection {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  status: "active" | "archived";
  documentCount: number;
  blockCount: number;
  tokenCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextDocument {
  id: string;
  tenantId: string | null;
  collectionId: string;
  title: string;
  source: string | null;
  sourceUri: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  blockCount: number;
  tokenCount: number;
  createdAt: Date;
}

export interface ContextBlock {
  id: string;
  tenantId: string | null;
  collectionId: string;
  documentId: string;
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  source: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface IngestContextDocumentInput {
  title?: string;
  text: string;
  source?: string;
  sourceUri?: string;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult<T> {
  value?: T;
  error?: string;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function collectionFromRow(row: typeof contextCollections.$inferSelect): ContextCollection {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    status: row.status,
    documentCount: row.documentCount,
    blockCount: row.blockCount,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function documentFromRow(row: typeof contextDocuments.$inferSelect): ContextDocument {
  return {
    id: row.id,
    tenantId: row.tenantId,
    collectionId: row.collectionId,
    title: row.title,
    source: row.source,
    sourceUri: row.sourceUri,
    contentHash: row.contentHash,
    metadata: parseMetadata(row.metadata),
    blockCount: row.blockCount,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt,
  };
}

function blockFromRow(row: typeof contextBlocks.$inferSelect): ContextBlock {
  return {
    id: row.id,
    tenantId: row.tenantId,
    collectionId: row.collectionId,
    documentId: row.documentId,
    ordinal: row.ordinal,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount,
    source: row.source,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}

function trimOptional(value: unknown, field: string, maxChars: number): ValidationResult<string | undefined> {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: undefined };
  if (trimmed.length > maxChars) return { error: `${field} must be at most ${maxChars} characters` };
  return { value: trimmed };
}

export function validateCreateCollectionBody(value: unknown): ValidationResult<{ name: string; description?: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const name = trimOptional(body.name, "name", MAX_COLLECTION_NAME_CHARS);
  if (name.error) return { error: name.error };
  if (!name.value) return { error: "name is required" };
  const description = trimOptional(body.description, "description", MAX_COLLECTION_DESCRIPTION_CHARS);
  if (description.error) return { error: description.error };
  return { value: { name: name.value, description: description.value } };
}

export function validateIngestDocumentBody(value: unknown): ValidationResult<IngestContextDocumentInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string") return { error: "text is required" };
  const text = body.text.trim();
  if (text.length === 0) return { error: "text is required" };
  if (text.length > MAX_INGEST_TEXT_CHARS) return { error: `text must be at most ${MAX_INGEST_TEXT_CHARS} characters` };

  const title = trimOptional(body.title, "title", MAX_DOCUMENT_TITLE_CHARS);
  if (title.error) return { error: title.error };
  const source = trimOptional(body.source, "source", MAX_SOURCE_CHARS);
  if (source.error) return { error: source.error };
  const sourceUri = trimOptional(body.sourceUri, "sourceUri", MAX_SOURCE_URI_CHARS);
  if (sourceUri.error) return { error: sourceUri.error };

  let metadata: Record<string, unknown> | undefined;
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)) {
      return { error: "metadata must be an object" };
    }
    const encoded = JSON.stringify(body.metadata);
    if (encoded.length > MAX_METADATA_CHARS) return { error: `metadata must encode to at most ${MAX_METADATA_CHARS} characters` };
    metadata = body.metadata as Record<string, unknown>;
  }

  return {
    value: {
      title: title.value,
      text,
      source: source.value,
      sourceUri: sourceUri.value,
      metadata,
    },
  };
}

export function chunkContextText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + TARGET_BLOCK_CHARS);
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf("\n\n", end);
      const sentence = normalized.lastIndexOf(". ", end);
      const space = normalized.lastIndexOf(" ", end);
      const boundary = [paragraph, sentence > -1 ? sentence + 1 : -1, space]
        .filter((index) => index >= start + MIN_BOUNDARY_CHARS)
        .sort((left, right) => right - left)[0];
      if (boundary !== undefined) end = boundary;
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < normalized.length && /\s/.test(normalized[start] ?? "")) start += 1;
  }

  return chunks;
}

export async function createContextCollection(
  db: Db,
  tenantId: string | null,
  input: { name: string; description?: string },
): Promise<ContextCollection> {
  const duplicateWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.name, input.name));
  const existing = await db.select({ id: contextCollections.id }).from(contextCollections).where(duplicateWhere).get();
  if (existing) throw new Error("collection name already exists");

  const id = nanoid();
  const now = new Date();
  await db.insert(contextCollections).values({
    id,
    tenantId,
    name: input.name,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();

  const row = await db.select().from(contextCollections).where(eq(contextCollections.id, id)).get();
  if (!row) throw new Error("Failed to create context collection");
  return collectionFromRow(row);
}

export async function listContextCollections(db: Db, tenantId: string | null): Promise<ContextCollection[]> {
  const rows = await db
    .select()
    .from(contextCollections)
    .where(tenantFilter(contextCollections.tenantId, tenantId))
    .orderBy(desc(contextCollections.updatedAt))
    .all();
  return rows.map(collectionFromRow);
}

export async function ingestContextDocument(
  db: Db,
  tenantId: string | null,
  collectionId: string,
  input: IngestContextDocumentInput,
): Promise<{ collection: ContextCollection; document: ContextDocument; blocks: ContextBlock[] }> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collection = await db.select().from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("collection not found");
  if (collection.status !== "active") throw new Error("collection is archived");

  const rawBlocks = chunkContextText(input.text);
  if (rawBlocks.length === 0) throw new Error("text is required");
  const now = new Date();
  const documentId = nanoid();
  const blockRows = rawBlocks.map((content, index) => {
    const metadata = {
      ...(input.metadata ?? {}),
      sourceDocumentId: documentId,
      blockOrdinal: index,
    };
    return {
      id: nanoid(),
      tenantId,
      collectionId,
      documentId,
      ordinal: index,
      content,
      contentHash: hashContent(content),
      tokenCount: estimateContextTokens(content),
      source: input.source ?? null,
      metadata: JSON.stringify(metadata),
      createdAt: now,
    };
  });
  const tokenCount = blockRows.reduce((sum, block) => sum + block.tokenCount, 0);

  await db.insert(contextDocuments).values({
    id: documentId,
    tenantId,
    collectionId,
    title: input.title ?? input.source ?? "Untitled document",
    source: input.source ?? null,
    sourceUri: input.sourceUri ?? null,
    contentHash: hashContent(input.text),
    metadata: JSON.stringify(input.metadata ?? {}),
    blockCount: blockRows.length,
    tokenCount,
    createdAt: now,
  }).run();
  for (let index = 0; index < blockRows.length; index += BLOCK_INSERT_BATCH_SIZE) {
    await db.insert(contextBlocks).values(blockRows.slice(index, index + BLOCK_INSERT_BATCH_SIZE)).run();
  }

  await db.update(contextCollections).set({
    documentCount: collection.documentCount + 1,
    blockCount: collection.blockCount + blockRows.length,
    tokenCount: collection.tokenCount + tokenCount,
    updatedAt: now,
  }).where(eq(contextCollections.id, collectionId)).run();

  const updatedCollection = await db.select().from(contextCollections).where(eq(contextCollections.id, collectionId)).get();
  const document = await db.select().from(contextDocuments).where(eq(contextDocuments.id, documentId)).get();
  const blocks = await db
    .select()
    .from(contextBlocks)
    .where(and(eq(contextBlocks.documentId, documentId), eq(contextBlocks.collectionId, collectionId)))
    .orderBy(contextBlocks.ordinal)
    .all();

  if (!updatedCollection || !document) throw new Error("Failed to ingest context document");
  return {
    collection: collectionFromRow(updatedCollection),
    document: documentFromRow(document),
    blocks: blocks.map(blockFromRow),
  };
}
