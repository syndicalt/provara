import { createHash } from "node:crypto";
import type { Db } from "@provara/db";
import {
  contextBlocks,
  contextCanonicalBlocks,
  contextCanonicalReviewEvents,
  contextCollections,
  contextDocuments,
} from "@provara/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter, tenantScoped } from "../auth/tenant.js";
import { estimateContextTokens } from "./optimizer.js";

const MAX_COLLECTION_NAME_CHARS = 120;
const MAX_COLLECTION_DESCRIPTION_CHARS = 1_000;
const MAX_DOCUMENT_TITLE_CHARS = 200;
const MAX_SOURCE_CHARS = 120;
const MAX_SOURCE_URI_CHARS = 2_000;
const MAX_METADATA_CHARS = 20_000;
const MAX_REVIEW_NOTE_CHARS = 2_000;
const MAX_BULK_CANONICAL_BLOCK_IDS = 100;
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
  canonicalBlockCount: number;
  approvedBlockCount: number;
  tokenCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextCanonicalBlock {
  id: string;
  tenantId: string | null;
  collectionId: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  sourceBlockIds: string[];
  sourceDocumentIds: string[];
  sourceCount: number;
  reviewStatus: "draft" | "approved" | "rejected";
  reviewNote: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  policyStatus: "unchecked" | "passed" | "failed";
  policyCheckedAt: Date | null;
  policyDetails: ContextCanonicalPolicyDetail[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextCanonicalPolicyDetail {
  decision: "allow" | "flag" | "redact" | "block" | "quarantine";
  ruleId: string | null;
  ruleName: string | null;
  action: string | null;
  matchedSnippet: string | null;
}

export interface ContextCanonicalReviewEvent {
  id: string;
  tenantId: string | null;
  collectionId: string;
  canonicalBlockId: string;
  fromStatus: ContextCanonicalBlock["reviewStatus"];
  toStatus: ContextCanonicalBlock["reviewStatus"];
  note: string | null;
  actorUserId: string | null;
  createdAt: Date;
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
    canonicalBlockCount: row.canonicalBlockCount,
    approvedBlockCount: row.approvedBlockCount,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parsePolicyDetails(value: string | null): ContextCanonicalPolicyDetail[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((detail): ContextCanonicalPolicyDetail[] => {
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return [];
      const record = detail as Record<string, unknown>;
      const decision = record.decision;
      if (
        decision !== "allow"
        && decision !== "flag"
        && decision !== "redact"
        && decision !== "block"
        && decision !== "quarantine"
      ) {
        return [];
      }
      return [{
        decision,
        ruleId: typeof record.ruleId === "string" ? record.ruleId : null,
        ruleName: typeof record.ruleName === "string" ? record.ruleName : null,
        action: typeof record.action === "string" ? record.action : null,
        matchedSnippet: typeof record.matchedSnippet === "string" ? record.matchedSnippet : null,
      }];
    });
  } catch {
    return [];
  }
}

function canonicalBlockFromRow(row: typeof contextCanonicalBlocks.$inferSelect): ContextCanonicalBlock {
  return {
    id: row.id,
    tenantId: row.tenantId,
    collectionId: row.collectionId,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount,
    sourceBlockIds: parseStringArray(row.sourceBlockIds),
    sourceDocumentIds: parseStringArray(row.sourceDocumentIds),
    sourceCount: row.sourceCount,
    reviewStatus: row.reviewStatus,
    reviewNote: row.reviewNote,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt,
    policyStatus: row.policyStatus,
    policyCheckedAt: row.policyCheckedAt,
    policyDetails: parsePolicyDetails(row.policyDetails),
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reviewEventFromRow(row: typeof contextCanonicalReviewEvents.$inferSelect): ContextCanonicalReviewEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    collectionId: row.collectionId,
    canonicalBlockId: row.canonicalBlockId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    note: row.note,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}

function normalizeCanonicalContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function refreshCollectionCanonicalCounts(db: Db, collectionId: string, updatedAt = new Date()): Promise<void> {
  const row = await db
    .select({
      canonicalBlockCount: sql<number>`count(*)`,
      approvedBlockCount: sql<number>`coalesce(sum(case when ${contextCanonicalBlocks.reviewStatus} = 'approved' then 1 else 0 end), 0)`,
    })
    .from(contextCanonicalBlocks)
    .where(eq(contextCanonicalBlocks.collectionId, collectionId))
    .get();

  await db.update(contextCollections).set({
    canonicalBlockCount: row?.canonicalBlockCount ?? 0,
    approvedBlockCount: row?.approvedBlockCount ?? 0,
    updatedAt,
  }).where(eq(contextCollections.id, collectionId)).run();
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

export function validateReviewStatusBody(value: unknown): ValidationResult<{ reviewStatus: ContextCanonicalBlock["reviewStatus"]; note?: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const reviewStatus = body.reviewStatus;
  if (reviewStatus !== "draft" && reviewStatus !== "approved" && reviewStatus !== "rejected") {
    return { error: "reviewStatus must be draft, approved, or rejected" };
  }
  const note = trimOptional(body.note, "note", MAX_REVIEW_NOTE_CHARS);
  if (note.error) return { error: note.error };
  return { value: { reviewStatus, note: note.value } };
}

function validateCanonicalBlockIds(value: unknown): ValidationResult<{ blockIds: string[] }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.blockIds)) return { error: "blockIds must be an array" };
  if (body.blockIds.length === 0) return { error: "blockIds must contain at least one id" };
  if (body.blockIds.length > MAX_BULK_CANONICAL_BLOCK_IDS) {
    return { error: `blockIds must contain at most ${MAX_BULK_CANONICAL_BLOCK_IDS} ids` };
  }
  const blockIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, id] of body.blockIds.entries()) {
    if (typeof id !== "string" || id.trim().length === 0) {
      return { error: `blockIds[${index}] must be a non-empty string` };
    }
    const trimmed = id.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      blockIds.push(trimmed);
    }
  }
  return { value: { blockIds } };
}

export function validateBulkPolicyCheckBody(value: unknown): ValidationResult<{ blockIds: string[] }> {
  return validateCanonicalBlockIds(value);
}

export function validateBulkReviewBody(value: unknown): ValidationResult<{
  blockIds: string[];
  reviewStatus: ContextCanonicalBlock["reviewStatus"];
  note?: string;
}> {
  const ids = validateCanonicalBlockIds(value);
  if (!ids.value) return { error: ids.error };
  const review = validateReviewStatusBody(value);
  if (!review.value) return { error: review.error };
  return {
    value: {
      blockIds: ids.value.blockIds,
      reviewStatus: review.value.reviewStatus,
      note: review.value.note,
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

export async function distillContextCollection(
  db: Db,
  tenantId: string | null,
  collectionId: string,
): Promise<{ collection: ContextCollection; canonicalBlocks: ContextCanonicalBlock[]; createdBlocks: number; mergedSources: number }> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collection = await db.select().from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("collection not found");

  const storedBlocks = await db
    .select()
    .from(contextBlocks)
    .where(tenantScoped(contextBlocks.tenantId, tenantId, eq(contextBlocks.collectionId, collectionId)))
    .orderBy(asc(contextBlocks.documentId), asc(contextBlocks.ordinal))
    .all();
  if (storedBlocks.length === 0) throw new Error("collection has no stored blocks");

  const groups = new Map<string, { content: string; blockIds: string[]; documentIds: string[]; tokenCount: number }>();
  for (const block of storedBlocks) {
    const content = normalizeCanonicalContent(block.content);
    if (!content) continue;
    const contentHash = hashContent(content.toLowerCase());
    const group = groups.get(contentHash);
    if (group) {
      group.blockIds.push(block.id);
      if (!group.documentIds.includes(block.documentId)) group.documentIds.push(block.documentId);
      continue;
    }
    groups.set(contentHash, {
      content,
      blockIds: [block.id],
      documentIds: [block.documentId],
      tokenCount: estimateContextTokens(content),
    });
  }

  const now = new Date();
  let createdBlocks = 0;
  let mergedSources = 0;
  for (const [contentHash, group] of groups) {
    const existing = await db
      .select()
      .from(contextCanonicalBlocks)
      .where(and(eq(contextCanonicalBlocks.collectionId, collectionId), eq(contextCanonicalBlocks.contentHash, contentHash)))
      .get();
    if (existing) {
      const sourceBlockIds = [...new Set([...parseStringArray(existing.sourceBlockIds), ...group.blockIds])];
      const sourceDocumentIds = [...new Set([...parseStringArray(existing.sourceDocumentIds), ...group.documentIds])];
      await db.update(contextCanonicalBlocks).set({
        sourceBlockIds: JSON.stringify(sourceBlockIds),
        sourceDocumentIds: JSON.stringify(sourceDocumentIds),
        sourceCount: sourceBlockIds.length,
        updatedAt: now,
      }).where(eq(contextCanonicalBlocks.id, existing.id)).run();
      mergedSources += Math.max(0, sourceBlockIds.length - existing.sourceCount);
      continue;
    }

    await db.insert(contextCanonicalBlocks).values({
      id: nanoid(),
      tenantId,
      collectionId,
      content: group.content,
      contentHash,
      tokenCount: group.tokenCount,
      sourceBlockIds: JSON.stringify(group.blockIds),
      sourceDocumentIds: JSON.stringify(group.documentIds),
      sourceCount: group.blockIds.length,
      reviewStatus: "draft",
      metadata: JSON.stringify({ distillation: "deterministic-v1" }),
      createdAt: now,
      updatedAt: now,
    }).run();
    createdBlocks += 1;
    mergedSources += Math.max(0, group.blockIds.length - 1);
  }

  await refreshCollectionCanonicalCounts(db, collectionId, now);
  const updatedCollection = await db.select().from(contextCollections).where(eq(contextCollections.id, collectionId)).get();
  const canonicalBlocks = await listContextCanonicalBlocks(db, tenantId, collectionId);
  if (!updatedCollection) throw new Error("Failed to distill context collection");
  return {
    collection: collectionFromRow(updatedCollection),
    canonicalBlocks,
    createdBlocks,
    mergedSources,
  };
}

export async function listContextCanonicalBlocks(
  db: Db,
  tenantId: string | null,
  collectionId: string,
  options: { reviewStatus?: ContextCanonicalBlock["reviewStatus"] } = {},
): Promise<ContextCanonicalBlock[]> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collection = await db.select({ id: contextCollections.id }).from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("collection not found");
  const conditions = [eq(contextCanonicalBlocks.collectionId, collectionId)];
  if (tenantId) conditions.push(eq(contextCanonicalBlocks.tenantId, tenantId));
  if (options.reviewStatus) conditions.push(eq(contextCanonicalBlocks.reviewStatus, options.reviewStatus));

  const rows = await db
    .select()
    .from(contextCanonicalBlocks)
    .where(and(...conditions))
    .orderBy(asc(contextCanonicalBlocks.createdAt), asc(contextCanonicalBlocks.id))
    .all();
  return rows.map(canonicalBlockFromRow);
}

export async function getContextCanonicalBlock(
  db: Db,
  tenantId: string | null,
  blockId: string,
): Promise<ContextCanonicalBlock> {
  const row = await db.select().from(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.id, blockId)).get();
  if (!row) throw new Error("canonical block not found");
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, row.collectionId));
  const collection = await db.select({ id: contextCollections.id }).from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("canonical block not found");
  return canonicalBlockFromRow(row);
}

export async function recordContextCanonicalPolicyCheck(
  db: Db,
  tenantId: string | null,
  blockId: string,
  scan: {
    decision: ContextCanonicalPolicyDetail["decision"];
    violations: {
      ruleId: string;
      ruleName: string;
      action: string;
      matchedSnippet: string;
    }[];
  },
): Promise<ContextCanonicalBlock> {
  await getContextCanonicalBlock(db, tenantId, blockId);
  const now = new Date();
  const failed = scan.decision === "block" || scan.decision === "quarantine";
  const policyDetails: ContextCanonicalPolicyDetail[] = scan.violations.length === 0
    ? [{
      decision: scan.decision,
      ruleId: null,
      ruleName: null,
      action: null,
      matchedSnippet: null,
    }]
    : scan.violations.map((violation) => ({
      decision: scan.decision,
      ruleId: violation.ruleId,
      ruleName: violation.ruleName,
      action: violation.action,
      matchedSnippet: violation.matchedSnippet,
    }));

  await db.update(contextCanonicalBlocks).set({
    policyStatus: failed ? "failed" : "passed",
    policyCheckedAt: now,
    policyDetails: JSON.stringify(policyDetails),
    updatedAt: now,
  }).where(eq(contextCanonicalBlocks.id, blockId)).run();

  const row = await db.select().from(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.id, blockId)).get();
  if (!row) throw new Error("Failed to record canonical block policy check");
  return canonicalBlockFromRow(row);
}

export async function updateContextCanonicalBlockReview(
  db: Db,
  tenantId: string | null,
  blockId: string,
  reviewStatus: ContextCanonicalBlock["reviewStatus"],
  options: { note?: string; actorUserId?: string | null } = {},
): Promise<ContextCanonicalBlock> {
  const existing = await db.select().from(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.id, blockId)).get();
  if (!existing) throw new Error("canonical block not found");
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, existing.collectionId));
  const collection = await db.select({ id: contextCollections.id }).from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("canonical block not found");
  if (reviewStatus === "approved" && existing.policyStatus !== "passed") {
    throw new Error("canonical block policy check must pass before approval");
  }

  const now = new Date();
  const reviewNote = options.note ?? null;
  const actorUserId = options.actorUserId ?? null;
  await db.update(contextCanonicalBlocks).set({
    reviewStatus,
    reviewNote,
    reviewedByUserId: actorUserId,
    reviewedAt: now,
    updatedAt: now,
  }).where(eq(contextCanonicalBlocks.id, blockId)).run();
  await db.insert(contextCanonicalReviewEvents).values({
    id: nanoid(),
    tenantId,
    collectionId: existing.collectionId,
    canonicalBlockId: blockId,
    fromStatus: existing.reviewStatus,
    toStatus: reviewStatus,
    note: reviewNote,
    actorUserId,
    createdAt: now,
  }).run();
  await refreshCollectionCanonicalCounts(db, existing.collectionId, now);

  const row = await db.select().from(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.id, blockId)).get();
  if (!row) throw new Error("Failed to update canonical block review status");
  return canonicalBlockFromRow(row);
}

export async function listContextCanonicalReviewEvents(
  db: Db,
  tenantId: string | null,
  options: { collectionId?: string; limit?: number } = {},
): Promise<ContextCanonicalReviewEvent[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const conditions = [];
  const tenantClause = tenantFilter(contextCanonicalReviewEvents.tenantId, tenantId);
  if (tenantClause) conditions.push(tenantClause);
  if (options.collectionId) conditions.push(eq(contextCanonicalReviewEvents.collectionId, options.collectionId));

  const rows = await db
    .select()
    .from(contextCanonicalReviewEvents)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(contextCanonicalReviewEvents.createdAt))
    .limit(limit)
    .all();
  return rows.map(reviewEventFromRow);
}

export async function exportApprovedContextBlocks(
  db: Db,
  tenantId: string | null,
  collectionId: string,
): Promise<ContextCanonicalBlock[]> {
  return listContextCanonicalBlocks(db, tenantId, collectionId, { reviewStatus: "approved" });
}
