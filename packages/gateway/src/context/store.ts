import { createHash } from "node:crypto";
import type { Db } from "@provara/db";
import {
  contextBlocks,
  contextCanonicalBlocks,
  contextCanonicalReviewEvents,
  contextCollections,
  contextDocuments,
  contextSources,
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
const MAX_GITHUB_OWNER_CHARS = 100;
const MAX_GITHUB_REPO_CHARS = 100;
const MAX_GITHUB_BRANCH_CHARS = 200;
const MAX_GITHUB_PATH_CHARS = 1_000;
const MAX_GITHUB_EXTENSION_CHARS = 24;
const MAX_GITHUB_FILE_BYTES = 250_000;
const MAX_GITHUB_FILES = 100;
const TARGET_BLOCK_CHARS = 1_800;
const MIN_BOUNDARY_CHARS = 900;
const BLOCK_INSERT_BATCH_SIZE = 50;

type ContextSourceType = "manual" | "github_repository";

export interface GitHubSourceConfig {
  owner: string;
  repo: string;
  branch: string;
  path?: string;
  extensions: string[];
  maxFileBytes: number;
  maxFiles: number;
}

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

export interface ContextSource {
  id: string;
  tenantId: string | null;
  collectionId: string;
  name: string;
  type: ContextSourceType;
  externalId: string | null;
  sourceUri: string | null;
  contentHash: string;
  syncStatus: "pending" | "synced" | "failed";
  lastSyncedAt: Date | null;
  lastDocumentId: string | null;
  documentCount: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
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

export interface CreateContextSourceInput {
  name: string;
  type: ContextSourceType;
  externalId?: string;
  sourceUri?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  github?: GitHubSourceConfig;
}

export interface ValidationResult<T> {
  value?: T;
  error?: string;
}

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubFileCandidate {
  path: string;
  sha: string;
  size: number;
}

interface GitHubSyncFile extends GitHubFileCandidate {
  content: string;
}

export interface ContextSourceSyncOptions {
  fetch?: typeof fetch;
  githubToken?: string;
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

function normalizeGithubExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function parseGithubConfig(metadata: Record<string, unknown>): GitHubSourceConfig {
  const github = metadata.github;
  if (typeof github !== "object" || github === null || Array.isArray(github)) {
    throw new Error("github source config is required");
  }
  const raw = github as Record<string, unknown>;
  const owner = typeof raw.owner === "string" ? raw.owner : "";
  const repo = typeof raw.repo === "string" ? raw.repo : "";
  const branch = typeof raw.branch === "string" ? raw.branch : "main";
  const path = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim().replace(/^\/+|\/+$/g, "") : undefined;
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((value): value is string => typeof value === "string").map(normalizeGithubExtension).filter(Boolean)
    : [".md", ".mdx", ".txt", ".rst", ".adoc"];
  const maxFileBytes = typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes)
    ? Math.min(Math.max(Math.trunc(raw.maxFileBytes), 1), MAX_GITHUB_FILE_BYTES)
    : MAX_GITHUB_FILE_BYTES;
  const maxFiles = typeof raw.maxFiles === "number" && Number.isFinite(raw.maxFiles)
    ? Math.min(Math.max(Math.trunc(raw.maxFiles), 1), MAX_GITHUB_FILES)
    : MAX_GITHUB_FILES;

  if (!owner || !repo || !branch) throw new Error("github owner, repo, and branch are required");
  return { owner, repo, branch, path, extensions, maxFileBytes, maxFiles };
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

function sourceFromRow(row: typeof contextSources.$inferSelect): ContextSource {
  return {
    id: row.id,
    tenantId: row.tenantId,
    collectionId: row.collectionId,
    name: row.name,
    type: row.type,
    externalId: row.externalId,
    sourceUri: row.sourceUri,
    contentHash: row.contentHash,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastDocumentId: row.lastDocumentId,
    documentCount: row.documentCount,
    lastError: row.lastError,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

export function validateCreateContextSourceBody(value: unknown): ValidationResult<CreateContextSourceInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const name = trimOptional(body.name, "name", MAX_DOCUMENT_TITLE_CHARS);
  if (name.error) return { error: name.error };
  if (!name.value) return { error: "name is required" };
  const type = body.type === undefined ? "manual" : body.type;
  if (type !== "manual" && type !== "github_repository") return { error: "type must be manual or github_repository" };
  const externalId = trimOptional(body.externalId, "externalId", MAX_SOURCE_URI_CHARS);
  if (externalId.error) return { error: externalId.error };
  const sourceUri = trimOptional(body.sourceUri, "sourceUri", MAX_SOURCE_URI_CHARS);
  if (sourceUri.error) return { error: sourceUri.error };
  if (type === "manual" && typeof body.content !== "string") return { error: "content is required" };
  if (body.content !== undefined && typeof body.content !== "string") return { error: "content must be a string" };
  if (typeof body.content === "string" && body.content.length > MAX_INGEST_TEXT_CHARS) {
    return { error: `content must be at most ${MAX_INGEST_TEXT_CHARS} characters` };
  }

  let metadata: Record<string, unknown> | undefined;
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)) {
      return { error: "metadata must be an object" };
    }
    const encoded = JSON.stringify(body.metadata);
    if (encoded.length > MAX_METADATA_CHARS) return { error: `metadata must encode to at most ${MAX_METADATA_CHARS} characters` };
    metadata = body.metadata as Record<string, unknown>;
  }

  let github: GitHubSourceConfig | undefined;
  if (type === "github_repository") {
    if (typeof body.github !== "object" || body.github === null || Array.isArray(body.github)) {
      return { error: "github config is required" };
    }
    const raw = body.github as Record<string, unknown>;
    const owner = trimOptional(raw.owner, "github.owner", MAX_GITHUB_OWNER_CHARS);
    if (owner.error) return { error: owner.error };
    if (!owner.value) return { error: "github.owner is required" };
    const repo = trimOptional(raw.repo, "github.repo", MAX_GITHUB_REPO_CHARS);
    if (repo.error) return { error: repo.error };
    if (!repo.value) return { error: "github.repo is required" };
    const branch = trimOptional(raw.branch, "github.branch", MAX_GITHUB_BRANCH_CHARS);
    if (branch.error) return { error: branch.error };
    const path = trimOptional(raw.path, "github.path", MAX_GITHUB_PATH_CHARS);
    if (path.error) return { error: path.error };

    let extensions = [".md", ".mdx", ".txt", ".rst", ".adoc"];
    if (raw.extensions !== undefined) {
      if (!Array.isArray(raw.extensions)) return { error: "github.extensions must be an array" };
      if (raw.extensions.length === 0 || raw.extensions.length > 20) return { error: "github.extensions must contain 1 to 20 entries" };
      extensions = [];
      for (const [index, entry] of raw.extensions.entries()) {
        if (typeof entry !== "string") return { error: `github.extensions[${index}] must be a string` };
        const normalized = normalizeGithubExtension(entry);
        if (!normalized) return { error: `github.extensions[${index}] is required` };
        if (normalized.length > MAX_GITHUB_EXTENSION_CHARS) {
          return { error: `github.extensions[${index}] must be at most ${MAX_GITHUB_EXTENSION_CHARS} characters` };
        }
        if (!extensions.includes(normalized)) extensions.push(normalized);
      }
    }

    const maxFileBytes = raw.maxFileBytes === undefined ? MAX_GITHUB_FILE_BYTES : raw.maxFileBytes;
    if (typeof maxFileBytes !== "number" || !Number.isFinite(maxFileBytes)) return { error: "github.maxFileBytes must be a number" };
    if (maxFileBytes < 1 || maxFileBytes > MAX_GITHUB_FILE_BYTES) {
      return { error: `github.maxFileBytes must be between 1 and ${MAX_GITHUB_FILE_BYTES}` };
    }
    const maxFiles = raw.maxFiles === undefined ? MAX_GITHUB_FILES : raw.maxFiles;
    if (typeof maxFiles !== "number" || !Number.isFinite(maxFiles)) return { error: "github.maxFiles must be a number" };
    if (maxFiles < 1 || maxFiles > MAX_GITHUB_FILES) {
      return { error: `github.maxFiles must be between 1 and ${MAX_GITHUB_FILES}` };
    }

    github = {
      owner: owner.value,
      repo: repo.value,
      branch: branch.value ?? "main",
      path: path.value?.replace(/^\/+|\/+$/g, ""),
      extensions,
      maxFileBytes: Math.trunc(maxFileBytes),
      maxFiles: Math.trunc(maxFiles),
    };
  }

  return {
    value: {
      name: name.value,
      type,
      externalId: externalId.value,
      sourceUri: sourceUri.value,
      content: typeof body.content === "string" ? body.content : undefined,
      metadata,
      github,
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

export async function createContextSource(
  db: Db,
  tenantId: string | null,
  collectionId: string,
  input: CreateContextSourceInput,
): Promise<ContextSource> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collection = await db.select().from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("collection not found");
  if (collection.status !== "active") throw new Error("collection is archived");

  const now = new Date();
  const id = nanoid();
  const metadata = input.github
    ? { ...(input.metadata ?? {}), github: input.github, githubSyncedFiles: {} }
    : input.metadata ?? {};
  const sourceUri = input.sourceUri
    ?? (input.github ? `https://github.com/${input.github.owner}/${input.github.repo}/tree/${encodeURIComponent(input.github.branch)}` : null);
  const externalId = input.externalId
    ?? (input.github ? `github:${input.github.owner}/${input.github.repo}:${input.github.branch}:${input.github.path ?? ""}` : id);
  const content = input.content ?? "";
  await db.insert(contextSources).values({
    id,
    tenantId,
    collectionId,
    name: input.name,
    type: input.type,
    externalId,
    sourceUri,
    content,
    contentHash: hashContent(input.github ? JSON.stringify(input.github) : content),
    syncStatus: "pending",
    documentCount: 0,
    metadata: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  }).run();

  await db.update(contextCollections).set({ updatedAt: now }).where(eq(contextCollections.id, collectionId)).run();

  const row = await db.select().from(contextSources).where(eq(contextSources.id, id)).get();
  if (!row) throw new Error("Failed to create context source");
  return sourceFromRow(row);
}

export async function listContextSources(
  db: Db,
  tenantId: string | null,
  collectionId: string,
): Promise<ContextSource[]> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collection = await db.select({ id: contextCollections.id }).from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("collection not found");

  const conditions = [eq(contextSources.collectionId, collectionId)];
  const tenantClause = tenantFilter(contextSources.tenantId, tenantId);
  if (tenantClause) conditions.push(tenantClause);

  const rows = await db
    .select()
    .from(contextSources)
    .where(and(...conditions))
    .orderBy(desc(contextSources.updatedAt), asc(contextSources.id))
    .all();
  return rows.map(sourceFromRow);
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

function githubHeaders(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "provara-context-connector",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function githubApiUrl(path: string): string {
  return `https://api.github.com${path}`;
}

function shouldIngestGithubFile(item: GitHubTreeItem, config: GitHubSourceConfig): boolean {
  if (item.type !== "blob") return false;
  if (typeof item.size === "number" && item.size > config.maxFileBytes) return false;
  if (config.path && item.path !== config.path && !item.path.startsWith(`${config.path}/`)) return false;
  const lowerPath = item.path.toLowerCase();
  return config.extensions.some((extension) => lowerPath.endsWith(extension));
}

async function fetchGithubJson(fetchFn: typeof fetch, url: string, token?: string): Promise<unknown> {
  const response = await fetchFn(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`GitHub request failed (${response.status})${detail}`);
  }
  return response.json() as Promise<unknown>;
}

async function fetchGithubCandidates(
  fetchFn: typeof fetch,
  config: GitHubSourceConfig,
  token?: string,
): Promise<GitHubFileCandidate[]> {
  const treeUrl = githubApiUrl(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`);
  const payload = await fetchGithubJson(fetchFn, treeUrl, token);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("GitHub tree response is invalid");
  const tree = (payload as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) throw new Error("GitHub tree response is missing files");
  return tree
    .filter((item): item is GitHubTreeItem => (
      typeof item === "object"
      && item !== null
      && !Array.isArray(item)
      && typeof (item as GitHubTreeItem).path === "string"
      && typeof (item as GitHubTreeItem).type === "string"
      && typeof (item as GitHubTreeItem).sha === "string"
    ))
    .filter((item) => shouldIngestGithubFile(item, config))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, config.maxFiles)
    .map((item) => ({ path: item.path, sha: item.sha, size: typeof item.size === "number" ? item.size : 0 }));
}

async function fetchGithubFile(
  fetchFn: typeof fetch,
  config: GitHubSourceConfig,
  candidate: GitHubFileCandidate,
  token?: string,
): Promise<GitHubSyncFile> {
  const blobUrl = githubApiUrl(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/blobs/${encodeURIComponent(candidate.sha)}`);
  const payload = await fetchGithubJson(fetchFn, blobUrl, token);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error(`GitHub blob response is invalid for ${candidate.path}`);
  const blob = payload as { content?: unknown; encoding?: unknown; size?: unknown };
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error(`GitHub blob response is unsupported for ${candidate.path}`);
  }
  const size = typeof blob.size === "number" ? blob.size : candidate.size;
  if (size > config.maxFileBytes) throw new Error(`GitHub file exceeds maxFileBytes: ${candidate.path}`);
  const content = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (content.trim().length === 0) throw new Error(`GitHub file is empty: ${candidate.path}`);
  return { ...candidate, size, content };
}

function getSyncedGithubFiles(metadata: Record<string, unknown>): Record<string, string> {
  const files = metadata.githubSyncedFiles;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return {};
  const result: Record<string, string> = {};
  for (const [path, sha] of Object.entries(files)) {
    if (typeof sha === "string") result[path] = sha;
  }
  return result;
}

async function syncGithubContextSource(
  db: Db,
  tenantId: string | null,
  sourceRow: typeof contextSources.$inferSelect,
  collection: typeof contextCollections.$inferSelect,
  options: ContextSourceSyncOptions,
): Promise<{ source: ContextSource; collection: ContextCollection; document: ContextDocument | null; blocks: ContextBlock[]; synced: boolean }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error("fetch is unavailable");
  const metadata = parseMetadata(sourceRow.metadata);
  const config = parseGithubConfig(metadata);
  const syncedFiles = getSyncedGithubFiles(metadata);
  const candidates = await fetchGithubCandidates(fetchFn, config, options.githubToken);
  const changedCandidates = candidates.filter((candidate) => syncedFiles[candidate.path] !== candidate.sha);
  const now = new Date();

  if (changedCandidates.length === 0 && sourceRow.syncStatus === "synced") {
    await db.update(contextSources).set({
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
      metadata: JSON.stringify({
        ...metadata,
        githubLastSync: {
          checkedAt: now.toISOString(),
          matchedFiles: candidates.length,
          changedFiles: 0,
        },
      }),
    }).where(eq(contextSources.id, sourceRow.id)).run();
    const unchangedSource = await db.select().from(contextSources).where(eq(contextSources.id, sourceRow.id)).get();
    return {
      source: sourceFromRow(unchangedSource ?? sourceRow),
      collection: collectionFromRow(collection),
      document: null,
      blocks: [],
      synced: false,
    };
  }

  const allBlocks: ContextBlock[] = [];
  let lastDocument: ContextDocument | null = null;
  let latestCollection: ContextCollection = collectionFromRow(collection);
  const nextSyncedFiles = { ...syncedFiles };

  for (const candidate of changedCandidates) {
    const file = await fetchGithubFile(fetchFn, config, candidate, options.githubToken);
    const result = await ingestContextDocument(db, tenantId, sourceRow.collectionId, {
      title: file.path,
      text: file.content,
      source: `source:${sourceRow.type}`,
      sourceUri: `https://github.com/${config.owner}/${config.repo}/blob/${encodeURIComponent(config.branch)}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      metadata: {
        ...metadata,
        githubSyncedFiles: undefined,
        contextSourceId: sourceRow.id,
        contextSourceType: sourceRow.type,
        externalId: sourceRow.externalId,
        githubOwner: config.owner,
        githubRepo: config.repo,
        githubBranch: config.branch,
        githubPath: file.path,
        githubSha: file.sha,
        githubSize: file.size,
      },
    });
    nextSyncedFiles[file.path] = file.sha;
    latestCollection = result.collection;
    lastDocument = result.document;
    allBlocks.push(...result.blocks);
  }

  await db.update(contextSources).set({
    syncStatus: "synced",
    lastSyncedAt: now,
    lastDocumentId: lastDocument?.id ?? sourceRow.lastDocumentId,
    documentCount: sourceRow.documentCount + changedCandidates.length,
    lastError: null,
    contentHash: hashContent(candidates.map((candidate) => `${candidate.path}:${candidate.sha}`).join("\n")),
    metadata: JSON.stringify({
      ...metadata,
      githubSyncedFiles: nextSyncedFiles,
      githubLastSync: {
        checkedAt: now.toISOString(),
        matchedFiles: candidates.length,
        changedFiles: changedCandidates.length,
      },
    }),
    updatedAt: now,
  }).where(eq(contextSources.id, sourceRow.id)).run();

  const syncedSource = await db.select().from(contextSources).where(eq(contextSources.id, sourceRow.id)).get();
  if (!syncedSource) throw new Error("Failed to sync context source");
  return {
    source: sourceFromRow(syncedSource),
    collection: latestCollection,
    document: lastDocument,
    blocks: allBlocks,
    synced: changedCandidates.length > 0,
  };
}

export async function syncContextSource(
  db: Db,
  tenantId: string | null,
  sourceId: string,
  options: ContextSourceSyncOptions = {},
): Promise<{ source: ContextSource; collection: ContextCollection; document: ContextDocument | null; blocks: ContextBlock[]; synced: boolean }> {
  const sourceRow = await db.select().from(contextSources).where(eq(contextSources.id, sourceId)).get();
  if (!sourceRow) throw new Error("source not found");
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, sourceRow.collectionId));
  const collection = await db.select().from(contextCollections).where(collectionWhere).get();
  if (!collection) throw new Error("source not found");

  if (sourceRow.type === "github_repository") {
    const now = new Date();
    try {
      return await syncGithubContextSource(db, tenantId, sourceRow, collection, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync context source";
      await db.update(contextSources).set({
        syncStatus: "failed",
        lastError: message,
        updatedAt: now,
      }).where(eq(contextSources.id, sourceId)).run();
      throw new Error(message);
    }
  }

  if (sourceRow.syncStatus === "synced" && sourceRow.lastDocumentId && sourceRow.documentCount > 0) {
    const document = await db.select().from(contextDocuments).where(eq(contextDocuments.id, sourceRow.lastDocumentId)).get();
    const blocks = document
      ? await db.select().from(contextBlocks).where(eq(contextBlocks.documentId, document.id)).orderBy(contextBlocks.ordinal).all()
      : [];
    return {
      source: sourceFromRow(sourceRow),
      collection: collectionFromRow(collection),
      document: document ? documentFromRow(document) : null,
      blocks: blocks.map(blockFromRow),
      synced: false,
    };
  }

  const now = new Date();
  try {
    const result = await ingestContextDocument(db, tenantId, sourceRow.collectionId, {
      title: sourceRow.name,
      text: sourceRow.content,
      source: `source:${sourceRow.type}`,
      sourceUri: sourceRow.sourceUri ?? undefined,
      metadata: {
        ...parseMetadata(sourceRow.metadata),
        contextSourceId: sourceRow.id,
        contextSourceType: sourceRow.type,
        externalId: sourceRow.externalId,
      },
    });

    await db.update(contextSources).set({
      syncStatus: "synced",
      lastSyncedAt: now,
      lastDocumentId: result.document.id,
      documentCount: sourceRow.documentCount + 1,
      lastError: null,
      updatedAt: now,
    }).where(eq(contextSources.id, sourceId)).run();

    const syncedSource = await db.select().from(contextSources).where(eq(contextSources.id, sourceId)).get();
    if (!syncedSource) throw new Error("Failed to sync context source");
    return {
      source: sourceFromRow(syncedSource),
      collection: result.collection,
      document: result.document,
      blocks: result.blocks,
      synced: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync context source";
    await db.update(contextSources).set({
      syncStatus: "failed",
      lastError: message,
      updatedAt: now,
    }).where(eq(contextSources.id, sourceId)).run();
    throw new Error(message);
  }
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
