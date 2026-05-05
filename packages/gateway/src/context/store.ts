import { createHash, createHmac } from "node:crypto";
import type { Db } from "@provara/db";
import {
  contextBlocks,
  contextCanonicalBlocks,
  contextCanonicalReviewEvents,
  contextCollections,
  contextConnectorCredentials,
  contextDocuments,
  contextSources,
} from "@provara/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter, tenantScoped } from "../auth/tenant.js";
import { decrypt, encrypt, hasMasterKey } from "../crypto/index.js";
import { storeContextDocumentObject } from "../storage/documents.js";
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
const MAX_CREDENTIAL_NAME_CHARS = 120;
const MAX_CREDENTIAL_VALUE_CHARS = 20_000;
const MAX_UPLOAD_FILENAME_CHARS = 240;
const MAX_UPLOAD_CONTENT_TYPE_CHARS = 120;
const MAX_UPLOAD_BYTES = 500_000;
const MAX_S3_BUCKET_CHARS = 63;
const MAX_S3_REGION_CHARS = 64;
const MAX_S3_PREFIX_CHARS = 1_000;
const MAX_S3_EXTENSION_CHARS = 24;
const MAX_S3_FILE_BYTES = 250_000;
const MAX_S3_FILES = 100;
const MAX_CONFLUENCE_BASE_URL_CHARS = 300;
const MAX_CONFLUENCE_EMAIL_CHARS = 320;
const MAX_CONFLUENCE_SPACE_KEY_CHARS = 120;
const MAX_CONFLUENCE_LABEL_CHARS = 80;
const MAX_CONFLUENCE_TITLE_FILTER_CHARS = 120;
const MAX_CONFLUENCE_PAGE_BYTES = 250_000;
const MAX_CONFLUENCE_PAGES = 100;
const TARGET_BLOCK_CHARS = 1_800;
const MIN_BOUNDARY_CHARS = 900;
const BLOCK_INSERT_BATCH_SIZE = 50;

type ContextSourceType = "manual" | "github_repository" | "file_upload" | "s3_bucket" | "confluence_space";
type ContextConnectorCredentialType = "github_token" | "aws_access_key" | "confluence_api_token";

export interface GitHubSourceConfig {
  owner: string;
  repo: string;
  branch: string;
  path?: string;
  extensions: string[];
  maxFileBytes: number;
  maxFiles: number;
  credentialId?: string;
}

export interface FileUploadSourceConfig {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface S3SourceConfig {
  bucket: string;
  region: string;
  prefix?: string;
  extensions: string[];
  maxFileBytes: number;
  maxFiles: number;
  credentialId: string;
}

export interface ConfluenceSourceConfig {
  baseUrl: string;
  spaceKey: string;
  labels: string[];
  titleContains?: string;
  maxPageBytes: number;
  maxPages: number;
  credentialId: string;
}

interface AwsAccessKeyCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface ConfluenceApiTokenCredential {
  email: string;
  apiToken: string;
}

export interface ContextConnectorCredential {
  id: string;
  tenantId: string | null;
  name: string;
  type: ContextConnectorCredentialType;
  hasSecret: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

export interface DeleteContextCollectionResult {
  collection: ContextCollection;
  deleted: {
    sources: number;
    documents: number;
    blocks: number;
    canonicalBlocks: number;
    reviewEvents: number;
  };
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
  file?: FileUploadSourceConfig;
  s3?: S3SourceConfig;
  confluence?: ConfluenceSourceConfig;
}

export interface CreateContextConnectorCredentialInput {
  name: string;
  type: ContextConnectorCredentialType;
  value: string;
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

interface S3ObjectCandidate {
  key: string;
  etag: string;
  size: number;
  lastModified?: string;
}

interface S3SyncFile extends S3ObjectCandidate {
  content: string;
}

interface ConfluencePageCandidate {
  id: string;
  title: string;
  version: string;
  bodyHtml: string;
  webUrl: string;
  sizeBytes: number;
}

interface ConfluenceSyncPage extends ConfluencePageCandidate {
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

function normalizeConnectorExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeS3Prefix(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^\/+/, "") ?? "";
  return trimmed || undefined;
}

function normalizeConfluenceBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CONFLUENCE_BASE_URL_CHARS) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/wiki$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseAwsCredentialValue(value: string): AwsAccessKeyCredential | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const accessKeyId = typeof raw.accessKeyId === "string" ? raw.accessKeyId.trim() : "";
    const secretAccessKey = typeof raw.secretAccessKey === "string" ? raw.secretAccessKey.trim() : "";
    const sessionToken = typeof raw.sessionToken === "string" && raw.sessionToken.trim() ? raw.sessionToken.trim() : undefined;
    if (!accessKeyId || !secretAccessKey) return null;
    return { accessKeyId, secretAccessKey, sessionToken };
  } catch {
    return null;
  }
}

function parseConfluenceCredentialValue(value: string): ConfluenceApiTokenCredential | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    const apiToken = typeof raw.apiToken === "string" ? raw.apiToken.trim() : "";
    if (!email || email.length > MAX_CONFLUENCE_EMAIL_CHARS || !apiToken) return null;
    return { email, apiToken };
  } catch {
    return null;
  }
}

function sanitizeUploadFilename(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^\w .@()+,-]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, MAX_UPLOAD_FILENAME_CHARS)
    .trim() ?? "";
}

function isSafeUploadedText(value: string): boolean {
  if (value.includes("\0")) return false;
  let controlCount = 0;
  const limit = Math.min(value.length, 8_192);
  for (let index = 0; index < limit; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount += 1;
  }
  return controlCount <= Math.max(4, Math.floor(limit * 0.01));
}

function normalizeUploadContentType(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() || "text/plain";
  return trimmed.slice(0, MAX_UPLOAD_CONTENT_TYPE_CHARS);
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
  const credentialId = typeof raw.credentialId === "string" && raw.credentialId.trim() ? raw.credentialId.trim() : undefined;

  if (!owner || !repo || !branch) throw new Error("github owner, repo, and branch are required");
  return { owner, repo, branch, path, extensions, maxFileBytes, maxFiles, credentialId };
}

function parseS3Config(metadata: Record<string, unknown>): S3SourceConfig {
  const s3 = metadata.s3;
  if (typeof s3 !== "object" || s3 === null || Array.isArray(s3)) {
    throw new Error("s3 source config is required");
  }
  const raw = s3 as Record<string, unknown>;
  const bucket = typeof raw.bucket === "string" ? raw.bucket : "";
  const region = typeof raw.region === "string" ? raw.region : "";
  const prefix = typeof raw.prefix === "string" ? normalizeS3Prefix(raw.prefix) : undefined;
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((value): value is string => typeof value === "string").map(normalizeConnectorExtension).filter(Boolean)
    : [".md", ".mdx", ".txt", ".rst", ".adoc", ".csv", ".json"];
  const maxFileBytes = typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes)
    ? Math.min(Math.max(Math.trunc(raw.maxFileBytes), 1), MAX_S3_FILE_BYTES)
    : MAX_S3_FILE_BYTES;
  const maxFiles = typeof raw.maxFiles === "number" && Number.isFinite(raw.maxFiles)
    ? Math.min(Math.max(Math.trunc(raw.maxFiles), 1), MAX_S3_FILES)
    : MAX_S3_FILES;
  const credentialId = typeof raw.credentialId === "string" ? raw.credentialId.trim() : "";

  if (!bucket || !region || !credentialId) throw new Error("s3 bucket, region, and credentialId are required");
  return { bucket, region, prefix, extensions, maxFileBytes, maxFiles, credentialId };
}

function parseConfluenceConfig(metadata: Record<string, unknown>): ConfluenceSourceConfig {
  const confluence = metadata.confluence;
  if (typeof confluence !== "object" || confluence === null || Array.isArray(confluence)) {
    throw new Error("confluence source config is required");
  }
  const raw = confluence as Record<string, unknown>;
  const baseUrl = typeof raw.baseUrl === "string" ? normalizeConfluenceBaseUrl(raw.baseUrl) : null;
  const spaceKey = typeof raw.spaceKey === "string" ? raw.spaceKey.trim() : "";
  const labels = Array.isArray(raw.labels)
    ? raw.labels.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 20)
    : [];
  const titleContains = typeof raw.titleContains === "string" && raw.titleContains.trim() ? raw.titleContains.trim() : undefined;
  const maxPageBytes = typeof raw.maxPageBytes === "number" && Number.isFinite(raw.maxPageBytes)
    ? Math.min(Math.max(Math.trunc(raw.maxPageBytes), 1), MAX_CONFLUENCE_PAGE_BYTES)
    : MAX_CONFLUENCE_PAGE_BYTES;
  const maxPages = typeof raw.maxPages === "number" && Number.isFinite(raw.maxPages)
    ? Math.min(Math.max(Math.trunc(raw.maxPages), 1), MAX_CONFLUENCE_PAGES)
    : MAX_CONFLUENCE_PAGES;
  const credentialId = typeof raw.credentialId === "string" ? raw.credentialId.trim() : "";

  if (!baseUrl || !spaceKey || !credentialId) throw new Error("confluence baseUrl, spaceKey, and credentialId are required");
  return { baseUrl, spaceKey, labels, titleContains, maxPageBytes, maxPages, credentialId };
}

function credentialFromRow(row: typeof contextConnectorCredentials.$inferSelect): ContextConnectorCredential {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    type: row.type,
    hasSecret: true,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  if (type !== "manual" && type !== "github_repository" && type !== "file_upload" && type !== "s3_bucket" && type !== "confluence_space") {
    return { error: "type must be manual, github_repository, file_upload, s3_bucket, or confluence_space" };
  }
  const externalId = trimOptional(body.externalId, "externalId", MAX_SOURCE_URI_CHARS);
  if (externalId.error) return { error: externalId.error };
  const sourceUri = trimOptional(body.sourceUri, "sourceUri", MAX_SOURCE_URI_CHARS);
  if (sourceUri.error) return { error: sourceUri.error };
  if ((type === "manual" || type === "file_upload") && typeof body.content !== "string") return { error: "content is required" };
  if (body.content !== undefined && typeof body.content !== "string") return { error: "content must be a string" };
  if (typeof body.content === "string" && body.content.length > MAX_INGEST_TEXT_CHARS) {
    return { error: `content must be at most ${MAX_INGEST_TEXT_CHARS} characters` };
  }
  if (type === "file_upload" && typeof body.content === "string") {
    const byteLength = Buffer.byteLength(body.content, "utf8");
    if (byteLength > MAX_UPLOAD_BYTES) return { error: `file content must be at most ${MAX_UPLOAD_BYTES} bytes` };
    if (!isSafeUploadedText(body.content)) return { error: "file content must be text" };
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
    const credentialId = trimOptional(raw.credentialId, "github.credentialId", MAX_SOURCE_URI_CHARS);
    if (credentialId.error) return { error: credentialId.error };

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
      credentialId: credentialId.value,
    };
  }

  let file: FileUploadSourceConfig | undefined;
  if (type === "file_upload") {
    if (typeof body.file !== "object" || body.file === null || Array.isArray(body.file)) {
      return { error: "file config is required" };
    }
    const raw = body.file as Record<string, unknown>;
    if (typeof raw.filename !== "string") return { error: "file.filename is required" };
    const filename = sanitizeUploadFilename(raw.filename);
    if (!filename) return { error: "file.filename is required" };
    if (filename === "." || filename === "..") return { error: "file.filename is invalid" };
    const contentType = typeof raw.contentType === "string" ? normalizeUploadContentType(raw.contentType) : "text/plain";
    const sizeBytes = typeof body.content === "string" ? Buffer.byteLength(body.content, "utf8") : 0;
    file = { filename, contentType, sizeBytes };
  }

  let s3: S3SourceConfig | undefined;
  if (type === "s3_bucket") {
    if (typeof body.s3 !== "object" || body.s3 === null || Array.isArray(body.s3)) {
      return { error: "s3 config is required" };
    }
    const raw = body.s3 as Record<string, unknown>;
    const bucket = trimOptional(raw.bucket, "s3.bucket", MAX_S3_BUCKET_CHARS);
    if (bucket.error) return { error: bucket.error };
    if (!bucket.value) return { error: "s3.bucket is required" };
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.value) || bucket.value.includes("..")) {
      return { error: "s3.bucket is invalid" };
    }
    const region = trimOptional(raw.region, "s3.region", MAX_S3_REGION_CHARS);
    if (region.error) return { error: region.error };
    if (!region.value) return { error: "s3.region is required" };
    if (!/^[a-z0-9-]+$/.test(region.value)) return { error: "s3.region is invalid" };
    const prefix = trimOptional(raw.prefix, "s3.prefix", MAX_S3_PREFIX_CHARS);
    if (prefix.error) return { error: prefix.error };
    const credentialId = trimOptional(raw.credentialId, "s3.credentialId", MAX_SOURCE_URI_CHARS);
    if (credentialId.error) return { error: credentialId.error };
    if (!credentialId.value) return { error: "s3.credentialId is required" };

    let extensions = [".md", ".mdx", ".txt", ".rst", ".adoc", ".csv", ".json"];
    if (raw.extensions !== undefined) {
      if (!Array.isArray(raw.extensions)) return { error: "s3.extensions must be an array" };
      if (raw.extensions.length === 0 || raw.extensions.length > 20) return { error: "s3.extensions must contain 1 to 20 entries" };
      extensions = [];
      for (const [index, entry] of raw.extensions.entries()) {
        if (typeof entry !== "string") return { error: `s3.extensions[${index}] must be a string` };
        const normalized = normalizeConnectorExtension(entry);
        if (!normalized) return { error: `s3.extensions[${index}] is required` };
        if (normalized.length > MAX_S3_EXTENSION_CHARS) {
          return { error: `s3.extensions[${index}] must be at most ${MAX_S3_EXTENSION_CHARS} characters` };
        }
        if (!extensions.includes(normalized)) extensions.push(normalized);
      }
    }

    const maxFileBytes = raw.maxFileBytes === undefined ? MAX_S3_FILE_BYTES : raw.maxFileBytes;
    if (typeof maxFileBytes !== "number" || !Number.isFinite(maxFileBytes)) return { error: "s3.maxFileBytes must be a number" };
    if (maxFileBytes < 1 || maxFileBytes > MAX_S3_FILE_BYTES) {
      return { error: `s3.maxFileBytes must be between 1 and ${MAX_S3_FILE_BYTES}` };
    }
    const maxFiles = raw.maxFiles === undefined ? MAX_S3_FILES : raw.maxFiles;
    if (typeof maxFiles !== "number" || !Number.isFinite(maxFiles)) return { error: "s3.maxFiles must be a number" };
    if (maxFiles < 1 || maxFiles > MAX_S3_FILES) {
      return { error: `s3.maxFiles must be between 1 and ${MAX_S3_FILES}` };
    }

    s3 = {
      bucket: bucket.value,
      region: region.value,
      prefix: normalizeS3Prefix(prefix.value),
      extensions,
      maxFileBytes: Math.trunc(maxFileBytes),
      maxFiles: Math.trunc(maxFiles),
      credentialId: credentialId.value,
    };
  }

  let confluence: ConfluenceSourceConfig | undefined;
  if (type === "confluence_space") {
    if (typeof body.confluence !== "object" || body.confluence === null || Array.isArray(body.confluence)) {
      return { error: "confluence config is required" };
    }
    const raw = body.confluence as Record<string, unknown>;
    const baseUrl = trimOptional(raw.baseUrl, "confluence.baseUrl", MAX_CONFLUENCE_BASE_URL_CHARS);
    if (baseUrl.error) return { error: baseUrl.error };
    if (!baseUrl.value) return { error: "confluence.baseUrl is required" };
    const normalizedBaseUrl = normalizeConfluenceBaseUrl(baseUrl.value);
    if (!normalizedBaseUrl) return { error: "confluence.baseUrl must be an https URL" };
    const spaceKey = trimOptional(raw.spaceKey, "confluence.spaceKey", MAX_CONFLUENCE_SPACE_KEY_CHARS);
    if (spaceKey.error) return { error: spaceKey.error };
    if (!spaceKey.value) return { error: "confluence.spaceKey is required" };
    if (!/^[A-Za-z0-9_-]+$/.test(spaceKey.value)) return { error: "confluence.spaceKey is invalid" };
    const credentialId = trimOptional(raw.credentialId, "confluence.credentialId", MAX_SOURCE_URI_CHARS);
    if (credentialId.error) return { error: credentialId.error };
    if (!credentialId.value) return { error: "confluence.credentialId is required" };
    const titleContains = trimOptional(raw.titleContains, "confluence.titleContains", MAX_CONFLUENCE_TITLE_FILTER_CHARS);
    if (titleContains.error) return { error: titleContains.error };

    let labels: string[] = [];
    if (raw.labels !== undefined) {
      if (!Array.isArray(raw.labels)) return { error: "confluence.labels must be an array" };
      if (raw.labels.length > 20) return { error: "confluence.labels must contain at most 20 entries" };
      labels = [];
      for (const [index, entry] of raw.labels.entries()) {
        if (typeof entry !== "string") return { error: `confluence.labels[${index}] must be a string` };
        const label = entry.trim();
        if (!label) continue;
        if (label.length > MAX_CONFLUENCE_LABEL_CHARS) {
          return { error: `confluence.labels[${index}] must be at most ${MAX_CONFLUENCE_LABEL_CHARS} characters` };
        }
        if (!/^[A-Za-z0-9_.:-]+$/.test(label)) return { error: `confluence.labels[${index}] is invalid` };
        if (!labels.includes(label)) labels.push(label);
      }
    }

    const maxPageBytes = raw.maxPageBytes === undefined ? MAX_CONFLUENCE_PAGE_BYTES : raw.maxPageBytes;
    if (typeof maxPageBytes !== "number" || !Number.isFinite(maxPageBytes)) return { error: "confluence.maxPageBytes must be a number" };
    if (maxPageBytes < 1 || maxPageBytes > MAX_CONFLUENCE_PAGE_BYTES) {
      return { error: `confluence.maxPageBytes must be between 1 and ${MAX_CONFLUENCE_PAGE_BYTES}` };
    }
    const maxPages = raw.maxPages === undefined ? MAX_CONFLUENCE_PAGES : raw.maxPages;
    if (typeof maxPages !== "number" || !Number.isFinite(maxPages)) return { error: "confluence.maxPages must be a number" };
    if (maxPages < 1 || maxPages > MAX_CONFLUENCE_PAGES) {
      return { error: `confluence.maxPages must be between 1 and ${MAX_CONFLUENCE_PAGES}` };
    }

    confluence = {
      baseUrl: normalizedBaseUrl,
      spaceKey: spaceKey.value,
      labels,
      titleContains: titleContains.value,
      maxPageBytes: Math.trunc(maxPageBytes),
      maxPages: Math.trunc(maxPages),
      credentialId: credentialId.value,
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
      file,
      s3,
      confluence,
    },
  };
}

export function validateCreateContextConnectorCredentialBody(value: unknown): ValidationResult<CreateContextConnectorCredentialInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const name = trimOptional(body.name, "name", MAX_CREDENTIAL_NAME_CHARS);
  if (name.error) return { error: name.error };
  if (!name.value) return { error: "name is required" };
  const type = body.type === undefined ? "github_token" : body.type;
  if (type !== "github_token" && type !== "aws_access_key" && type !== "confluence_api_token") {
    return { error: "type must be github_token, aws_access_key, or confluence_api_token" };
  }
  if (typeof body.value !== "string") return { error: "value is required" };
  const credentialValue = body.value.trim();
  if (!credentialValue) return { error: "value cannot be empty or whitespace-only" };
  if (credentialValue.length > MAX_CREDENTIAL_VALUE_CHARS) return { error: `value must be at most ${MAX_CREDENTIAL_VALUE_CHARS} characters` };
  if (type === "aws_access_key" && !parseAwsCredentialValue(credentialValue)) {
    return { error: "value must be a JSON object with accessKeyId and secretAccessKey" };
  }
  if (type === "confluence_api_token" && !parseConfluenceCredentialValue(credentialValue)) {
    return { error: "value must be a JSON object with email and apiToken" };
  }
  return { value: { name: name.value, type, value: credentialValue } };
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

export async function deleteContextCollection(
  db: Db,
  tenantId: string | null,
  collectionId: string,
): Promise<DeleteContextCollectionResult> {
  const collectionWhere = tenantScoped(contextCollections.tenantId, tenantId, eq(contextCollections.id, collectionId));
  const collectionRow = await db.select().from(contextCollections).where(collectionWhere).get();
  if (!collectionRow) throw new Error("collection not found");
  const collection = collectionFromRow(collectionRow);

  const sourceCount = await db.select({ count: sql<number>`count(*)` }).from(contextSources).where(eq(contextSources.collectionId, collectionId)).get();
  const documentCount = await db.select({ count: sql<number>`count(*)` }).from(contextDocuments).where(eq(contextDocuments.collectionId, collectionId)).get();
  const blockCount = await db.select({ count: sql<number>`count(*)` }).from(contextBlocks).where(eq(contextBlocks.collectionId, collectionId)).get();
  const canonicalBlockCount = await db.select({ count: sql<number>`count(*)` }).from(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.collectionId, collectionId)).get();
  const reviewEventCount = await db.select({ count: sql<number>`count(*)` }).from(contextCanonicalReviewEvents).where(eq(contextCanonicalReviewEvents.collectionId, collectionId)).get();

  await db.delete(contextCanonicalReviewEvents).where(eq(contextCanonicalReviewEvents.collectionId, collectionId)).run();
  await db.delete(contextCanonicalBlocks).where(eq(contextCanonicalBlocks.collectionId, collectionId)).run();
  await db.delete(contextBlocks).where(eq(contextBlocks.collectionId, collectionId)).run();
  await db.delete(contextSources).where(eq(contextSources.collectionId, collectionId)).run();
  await db.delete(contextDocuments).where(eq(contextDocuments.collectionId, collectionId)).run();
  await db.delete(contextCollections).where(eq(contextCollections.id, collectionId)).run();

  return {
    collection,
    deleted: {
      sources: Number(sourceCount?.count ?? 0),
      documents: Number(documentCount?.count ?? 0),
      blocks: Number(blockCount?.count ?? 0),
      canonicalBlocks: Number(canonicalBlockCount?.count ?? 0),
      reviewEvents: Number(reviewEventCount?.count ?? 0),
    },
  };
}

export async function createContextConnectorCredential(
  db: Db,
  tenantId: string | null,
  input: CreateContextConnectorCredentialInput,
): Promise<ContextConnectorCredential> {
  if (!hasMasterKey()) throw new Error("PROVARA_MASTER_KEY not set");
  const now = new Date();
  const encrypted = encrypt(input.value);
  const existingWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.name, input.name));
  const existing = await db.select().from(contextConnectorCredentials).where(existingWhere).get();
  if (existing) {
    await db.update(contextConnectorCredentials).set({
      type: input.type,
      encryptedValue: encrypted.encrypted,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      updatedAt: now,
    }).where(eq(contextConnectorCredentials.id, existing.id)).run();
    const row = await db.select().from(contextConnectorCredentials).where(eq(contextConnectorCredentials.id, existing.id)).get();
    if (!row) throw new Error("Failed to update connector credential");
    return credentialFromRow(row);
  }

  const id = nanoid();
  await db.insert(contextConnectorCredentials).values({
    id,
    tenantId,
    name: input.name,
    type: input.type,
    encryptedValue: encrypted.encrypted,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    createdAt: now,
    updatedAt: now,
  }).run();
  const row = await db.select().from(contextConnectorCredentials).where(eq(contextConnectorCredentials.id, id)).get();
  if (!row) throw new Error("Failed to create connector credential");
  return credentialFromRow(row);
}

export async function listContextConnectorCredentials(db: Db, tenantId: string | null): Promise<ContextConnectorCredential[]> {
  const rows = await db
    .select()
    .from(contextConnectorCredentials)
    .where(tenantFilter(contextConnectorCredentials.tenantId, tenantId))
    .orderBy(desc(contextConnectorCredentials.updatedAt), asc(contextConnectorCredentials.id))
    .all();
  return rows.map(credentialFromRow);
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
  if (input.github?.credentialId) {
    const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, input.github.credentialId));
    const credential = await db.select({ id: contextConnectorCredentials.id }).from(contextConnectorCredentials).where(credentialWhere).get();
    if (!credential) throw new Error("connector credential not found");
  }
  if (input.s3?.credentialId) {
    const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, input.s3.credentialId));
    const credential = await db.select({ id: contextConnectorCredentials.id, type: contextConnectorCredentials.type }).from(contextConnectorCredentials).where(credentialWhere).get();
    if (!credential) throw new Error("connector credential not found");
    if (credential.type !== "aws_access_key") throw new Error("connector credential must be aws_access_key");
  }
  if (input.confluence?.credentialId) {
    const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, input.confluence.credentialId));
    const credential = await db.select({ id: contextConnectorCredentials.id, type: contextConnectorCredentials.type }).from(contextConnectorCredentials).where(credentialWhere).get();
    if (!credential) throw new Error("connector credential not found");
    if (credential.type !== "confluence_api_token") throw new Error("connector credential must be confluence_api_token");
  }

  const now = new Date();
  const id = nanoid();
  const metadata = input.github
    ? { ...(input.metadata ?? {}), github: input.github, githubSyncedFiles: {} }
    : input.s3
      ? { ...(input.metadata ?? {}), s3: input.s3, s3SyncedObjects: {} }
    : input.confluence
      ? { ...(input.metadata ?? {}), confluence: input.confluence, confluenceSyncedPages: {} }
    : input.file
      ? { ...(input.metadata ?? {}), file: input.file }
      : input.metadata ?? {};
  const sourceUri = input.sourceUri
    ?? (input.github
      ? `https://github.com/${input.github.owner}/${input.github.repo}/tree/${encodeURIComponent(input.github.branch)}`
      : input.s3
        ? `s3://${input.s3.bucket}/${input.s3.prefix ?? ""}`
      : input.confluence
        ? `${input.confluence.baseUrl}/wiki/spaces/${encodeURIComponent(input.confluence.spaceKey)}`
      : input.file
        ? `upload://${encodeURIComponent(input.file.filename)}`
        : null);
  const externalId = input.externalId
    ?? (input.github
      ? `github:${input.github.owner}/${input.github.repo}:${input.github.branch}:${input.github.path ?? ""}`
      : input.s3
        ? `s3:${input.s3.bucket}:${input.s3.region}:${input.s3.prefix ?? ""}`
      : input.confluence
        ? `confluence:${input.confluence.baseUrl}:${input.confluence.spaceKey}:${input.confluence.labels.join(",")}:${input.confluence.titleContains ?? ""}`
      : input.file
        ? `upload:${hashContent(`${input.file.filename}:${input.content ?? ""}`).slice(0, 32)}`
        : id);
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
    contentHash: hashContent(input.github ? JSON.stringify(input.github) : input.s3 ? JSON.stringify(input.s3) : input.confluence ? JSON.stringify(input.confluence) : content),
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
  const documentContentHash = hashContent(input.text);
  const storage = await storeContextDocumentObject({
    tenantId,
    collectionId,
    documentId,
    title: input.title ?? input.source ?? "Untitled document",
    text: input.text,
    contentHash: documentContentHash,
  });
  const documentMetadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    ...(storage ? { documentStorage: storage } : {}),
  };
  const blockRows = rawBlocks.map((content, index) => {
    const metadata = {
      ...documentMetadata,
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
    contentHash: documentContentHash,
    metadata: JSON.stringify(documentMetadata),
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

function getSyncedS3Objects(metadata: Record<string, unknown>): Record<string, string> {
  const objects = metadata.s3SyncedObjects;
  if (typeof objects !== "object" || objects === null || Array.isArray(objects)) return {};
  const result: Record<string, string> = {};
  for (const [key, etag] of Object.entries(objects)) {
    if (typeof etag === "string") result[key] = etag;
  }
  return result;
}

function getSyncedConfluencePages(metadata: Record<string, unknown>): Record<string, string> {
  const pages = metadata.confluenceSyncedPages;
  if (typeof pages !== "object" || pages === null || Array.isArray(pages)) return {};
  const result: Record<string, string> = {};
  for (const [id, version] of Object.entries(pages)) {
    if (typeof version === "string") result[id] = version;
  }
  return result;
}

async function resolveGithubToken(
  db: Db,
  tenantId: string | null,
  credentialId: string | undefined,
  fallbackToken: string | undefined,
): Promise<string | undefined> {
  if (!credentialId) return fallbackToken;
  if (!hasMasterKey()) throw new Error("PROVARA_MASTER_KEY not set");
  const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, credentialId));
  const credential = await db.select().from(contextConnectorCredentials).where(credentialWhere).get();
  if (!credential) throw new Error("connector credential not found");
  if (credential.type !== "github_token") throw new Error("connector credential must be github_token");
  try {
    const token = decrypt({
      encrypted: credential.encryptedValue,
      iv: credential.iv,
      authTag: credential.authTag,
    }).replace(/[^\x20-\x7E\t]/g, "").trim();
    if (!token) throw new Error("connector credential is empty");
    await db.update(contextConnectorCredentials).set({
      lastUsedAt: new Date(),
    }).where(eq(contextConnectorCredentials.id, credential.id)).run();
    return token;
  } catch (err) {
    if (err instanceof Error && err.message === "connector credential is empty") throw err;
    throw new Error("connector credential could not be decrypted");
  }
}

async function resolveAwsCredential(
  db: Db,
  tenantId: string | null,
  credentialId: string,
): Promise<AwsAccessKeyCredential> {
  if (!hasMasterKey()) throw new Error("PROVARA_MASTER_KEY not set");
  const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, credentialId));
  const credential = await db.select().from(contextConnectorCredentials).where(credentialWhere).get();
  if (!credential) throw new Error("connector credential not found");
  if (credential.type !== "aws_access_key") throw new Error("connector credential must be aws_access_key");
  try {
    const raw = decrypt({
      encrypted: credential.encryptedValue,
      iv: credential.iv,
      authTag: credential.authTag,
    }).replace(/[^\x20-\x7E\t\r\n]/g, "").trim();
    const parsed = parseAwsCredentialValue(raw);
    if (!parsed) throw new Error("connector credential is invalid");
    await db.update(contextConnectorCredentials).set({
      lastUsedAt: new Date(),
    }).where(eq(contextConnectorCredentials.id, credential.id)).run();
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message === "connector credential is invalid") throw err;
    throw new Error("connector credential could not be decrypted");
  }
}

async function resolveConfluenceCredential(
  db: Db,
  tenantId: string | null,
  credentialId: string,
): Promise<ConfluenceApiTokenCredential> {
  if (!hasMasterKey()) throw new Error("PROVARA_MASTER_KEY not set");
  const credentialWhere = tenantScoped(contextConnectorCredentials.tenantId, tenantId, eq(contextConnectorCredentials.id, credentialId));
  const credential = await db.select().from(contextConnectorCredentials).where(credentialWhere).get();
  if (!credential) throw new Error("connector credential not found");
  if (credential.type !== "confluence_api_token") throw new Error("connector credential must be confluence_api_token");
  try {
    const raw = decrypt({
      encrypted: credential.encryptedValue,
      iv: credential.iv,
      authTag: credential.authTag,
    }).replace(/[^\x20-\x7E\t\r\n]/g, "").trim();
    const parsed = parseConfluenceCredentialValue(raw);
    if (!parsed) throw new Error("connector credential is invalid");
    await db.update(contextConnectorCredentials).set({
      lastUsedAt: new Date(),
    }).where(eq(contextConnectorCredentials.id, credential.id)).run();
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message === "connector credential is invalid") throw err;
    throw new Error("connector credential could not be decrypted");
  }
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeS3KeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function s3Host(config: S3SourceConfig): string {
  return `${config.bucket}.s3.${config.region}.amazonaws.com`;
}

function signS3Request(
  method: "GET",
  url: URL,
  config: S3SourceConfig,
  credential: AwsAccessKeyCredential,
  now = new Date(),
): HeadersInit {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credential.sessionToken) headers["x-amz-security-token"] = credential.sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalQuery = Array.from(url.searchParams.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonicalRequest = [
    method,
    url.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credential.secretAccessKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    Host: headers.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(credential.sessionToken ? { "x-amz-security-token": credential.sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXml(match[1] ?? "") : undefined;
}

function shouldIngestS3Object(candidate: S3ObjectCandidate, config: S3SourceConfig): boolean {
  if (candidate.size <= 0 || candidate.size > config.maxFileBytes) return false;
  const lowerKey = candidate.key.toLowerCase();
  return config.extensions.some((extension) => lowerKey.endsWith(extension));
}

async function fetchS3Text(fetchFn: typeof fetch, url: URL, config: S3SourceConfig, credential: AwsAccessKeyCredential): Promise<string> {
  const response = await fetchFn(url, { headers: signS3Request("GET", url, config, credential) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`S3 request failed (${response.status})${detail}`);
  }
  return response.text();
}

async function fetchS3Candidates(
  fetchFn: typeof fetch,
  config: S3SourceConfig,
  credential: AwsAccessKeyCredential,
): Promise<S3ObjectCandidate[]> {
  const url = new URL(`https://${s3Host(config)}/`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("max-keys", String(config.maxFiles));
  if (config.prefix) url.searchParams.set("prefix", config.prefix);
  const xml = await fetchS3Text(fetchFn, url, config, credential);
  const objects: S3ObjectCandidate[] = [];
  const matches = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
  for (const match of matches) {
    const block = match[1] ?? "";
    const key = xmlText(block, "Key");
    const etag = xmlText(block, "ETag")?.replace(/^"|"$/g, "");
    const size = Number(xmlText(block, "Size") ?? "0");
    const lastModified = xmlText(block, "LastModified");
    if (!key || !etag || !Number.isFinite(size)) continue;
    objects.push({ key, etag, size, lastModified });
    if (objects.length >= config.maxFiles) break;
  }
  return objects
    .filter((candidate) => shouldIngestS3Object(candidate, config))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, config.maxFiles);
}

async function fetchS3File(
  fetchFn: typeof fetch,
  config: S3SourceConfig,
  credential: AwsAccessKeyCredential,
  candidate: S3ObjectCandidate,
): Promise<S3SyncFile> {
  if (candidate.size > config.maxFileBytes) throw new Error(`S3 object exceeds maxFileBytes: ${candidate.key}`);
  const url = new URL(`https://${s3Host(config)}/${encodeS3KeyPath(candidate.key)}`);
  const content = await fetchS3Text(fetchFn, url, config, credential);
  if (Buffer.byteLength(content, "utf8") > config.maxFileBytes) throw new Error(`S3 object exceeds maxFileBytes: ${candidate.key}`);
  if (!isSafeUploadedText(content)) throw new Error(`S3 object must be text: ${candidate.key}`);
  if (content.trim().length === 0) throw new Error(`S3 object is empty: ${candidate.key}`);
  return { ...candidate, content };
}

function confluenceHeaders(credential: ConfluenceApiTokenCredential): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${credential.email}:${credential.apiToken}`).toString("base64")}`,
    "User-Agent": "provara-context-connector",
  };
}

function confluenceApiUrl(config: ConfluenceSourceConfig): URL {
  const url = new URL(`${config.baseUrl}/wiki/rest/api/content/search`);
  const cqlParts = [`space="${config.spaceKey.replace(/"/g, "")}"`, "type=page"];
  if (config.titleContains) cqlParts.push(`title~"${config.titleContains.replace(/"/g, "")}"`);
  for (const label of config.labels) cqlParts.push(`label="${label.replace(/"/g, "")}"`);
  url.searchParams.set("cql", cqlParts.join(" and "));
  url.searchParams.set("limit", String(config.maxPages));
  url.searchParams.set("expand", "body.storage,version,_links");
  return url;
}

function confluencePageUrl(config: ConfluenceSourceConfig, links: Record<string, unknown>, id: string): string {
  const webui = typeof links.webui === "string" ? links.webui : "";
  if (webui) return `${config.baseUrl}${webui.startsWith("/") ? "" : "/"}${webui}`;
  return `${config.baseUrl}/wiki/pages/${encodeURIComponent(id)}`;
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchConfluenceJson(
  fetchFn: typeof fetch,
  url: URL,
  credential: ConfluenceApiTokenCredential,
): Promise<unknown> {
  const response = await fetchFn(url, { headers: confluenceHeaders(credential) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`Confluence request failed (${response.status})${detail}`);
  }
  return response.json() as Promise<unknown>;
}

async function fetchConfluenceCandidates(
  fetchFn: typeof fetch,
  config: ConfluenceSourceConfig,
  credential: ConfluenceApiTokenCredential,
): Promise<ConfluencePageCandidate[]> {
  const payload = await fetchConfluenceJson(fetchFn, confluenceApiUrl(config), credential);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Confluence response is invalid");
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("Confluence response is missing pages");
  const pages: ConfluencePageCandidate[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const page = entry as Record<string, unknown>;
    const id = typeof page.id === "string" ? page.id : "";
    const title = typeof page.title === "string" ? page.title.trim() : "";
    const versionRaw = typeof page.version === "object" && page.version !== null && !Array.isArray(page.version)
      ? (page.version as Record<string, unknown>).number
      : undefined;
    const version = typeof versionRaw === "number" || typeof versionRaw === "string" ? String(versionRaw) : "";
    const body = typeof page.body === "object" && page.body !== null && !Array.isArray(page.body)
      ? (page.body as Record<string, unknown>).storage
      : undefined;
    const bodyHtml = typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as Record<string, unknown>).value === "string"
      ? (body as Record<string, unknown>).value as string
      : "";
    const links = typeof page._links === "object" && page._links !== null && !Array.isArray(page._links)
      ? page._links as Record<string, unknown>
      : {};
    const sizeBytes = Buffer.byteLength(bodyHtml, "utf8");
    if (!id || !title || !version || sizeBytes <= 0 || sizeBytes > config.maxPageBytes) continue;
    pages.push({
      id,
      title,
      version,
      bodyHtml,
      webUrl: confluencePageUrl(config, links, id),
      sizeBytes,
    });
    if (pages.length >= config.maxPages) break;
  }
  return pages.sort((left, right) => left.title.localeCompare(right.title)).slice(0, config.maxPages);
}

function confluenceSyncPage(config: ConfluenceSourceConfig, candidate: ConfluencePageCandidate): ConfluenceSyncPage {
  if (candidate.sizeBytes > config.maxPageBytes) throw new Error(`Confluence page exceeds maxPageBytes: ${candidate.id}`);
  const content = htmlToText(candidate.bodyHtml);
  if (Buffer.byteLength(content, "utf8") > config.maxPageBytes) throw new Error(`Confluence page exceeds maxPageBytes: ${candidate.id}`);
  if (!isSafeUploadedText(content)) throw new Error(`Confluence page must be text: ${candidate.id}`);
  if (content.trim().length === 0) throw new Error(`Confluence page is empty: ${candidate.id}`);
  return { ...candidate, content };
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
  const githubToken = await resolveGithubToken(db, tenantId, config.credentialId, options.githubToken);
  const syncedFiles = getSyncedGithubFiles(metadata);
  const candidates = await fetchGithubCandidates(fetchFn, config, githubToken);
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
    const file = await fetchGithubFile(fetchFn, config, candidate, githubToken);
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

async function syncS3ContextSource(
  db: Db,
  tenantId: string | null,
  sourceRow: typeof contextSources.$inferSelect,
  collection: typeof contextCollections.$inferSelect,
  options: ContextSourceSyncOptions,
): Promise<{ source: ContextSource; collection: ContextCollection; document: ContextDocument | null; blocks: ContextBlock[]; synced: boolean }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error("fetch is unavailable");
  const metadata = parseMetadata(sourceRow.metadata);
  const config = parseS3Config(metadata);
  const credential = await resolveAwsCredential(db, tenantId, config.credentialId);
  const syncedObjects = getSyncedS3Objects(metadata);
  const candidates = await fetchS3Candidates(fetchFn, config, credential);
  const changedCandidates = candidates.filter((candidate) => syncedObjects[candidate.key] !== candidate.etag);
  const now = new Date();

  if (changedCandidates.length === 0 && sourceRow.syncStatus === "synced") {
    await db.update(contextSources).set({
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
      metadata: JSON.stringify({
        ...metadata,
        s3LastSync: {
          checkedAt: now.toISOString(),
          matchedObjects: candidates.length,
          changedObjects: 0,
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
  const nextSyncedObjects = { ...syncedObjects };

  for (const candidate of changedCandidates) {
    const file = await fetchS3File(fetchFn, config, credential, candidate);
    const result = await ingestContextDocument(db, tenantId, sourceRow.collectionId, {
      title: file.key,
      text: file.content,
      source: `source:${sourceRow.type}`,
      sourceUri: `s3://${config.bucket}/${file.key}`,
      metadata: {
        ...metadata,
        s3SyncedObjects: undefined,
        contextSourceId: sourceRow.id,
        contextSourceType: sourceRow.type,
        externalId: sourceRow.externalId,
        s3Bucket: config.bucket,
        s3Region: config.region,
        s3Prefix: config.prefix ?? null,
        s3Key: file.key,
        s3Etag: file.etag,
        s3Size: file.size,
        s3LastModified: file.lastModified ?? null,
      },
    });
    nextSyncedObjects[file.key] = file.etag;
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
    contentHash: hashContent(candidates.map((candidate) => `${candidate.key}:${candidate.etag}`).join("\n")),
    metadata: JSON.stringify({
      ...metadata,
      s3SyncedObjects: nextSyncedObjects,
      s3LastSync: {
        checkedAt: now.toISOString(),
        matchedObjects: candidates.length,
        changedObjects: changedCandidates.length,
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

async function syncConfluenceContextSource(
  db: Db,
  tenantId: string | null,
  sourceRow: typeof contextSources.$inferSelect,
  collection: typeof contextCollections.$inferSelect,
  options: ContextSourceSyncOptions,
): Promise<{ source: ContextSource; collection: ContextCollection; document: ContextDocument | null; blocks: ContextBlock[]; synced: boolean }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error("fetch is unavailable");
  const metadata = parseMetadata(sourceRow.metadata);
  const config = parseConfluenceConfig(metadata);
  const credential = await resolveConfluenceCredential(db, tenantId, config.credentialId);
  const syncedPages = getSyncedConfluencePages(metadata);
  const candidates = await fetchConfluenceCandidates(fetchFn, config, credential);
  const changedCandidates = candidates.filter((candidate) => syncedPages[candidate.id] !== candidate.version);
  const now = new Date();

  if (changedCandidates.length === 0 && sourceRow.syncStatus === "synced") {
    await db.update(contextSources).set({
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
      metadata: JSON.stringify({
        ...metadata,
        confluenceLastSync: {
          checkedAt: now.toISOString(),
          matchedPages: candidates.length,
          changedPages: 0,
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
  const nextSyncedPages = { ...syncedPages };

  for (const candidate of changedCandidates) {
    const page = confluenceSyncPage(config, candidate);
    const result = await ingestContextDocument(db, tenantId, sourceRow.collectionId, {
      title: page.title,
      text: page.content,
      source: `source:${sourceRow.type}`,
      sourceUri: page.webUrl,
      metadata: {
        ...metadata,
        confluenceSyncedPages: undefined,
        contextSourceId: sourceRow.id,
        contextSourceType: sourceRow.type,
        externalId: sourceRow.externalId,
        confluenceBaseUrl: config.baseUrl,
        confluenceSpaceKey: config.spaceKey,
        confluencePageId: page.id,
        confluencePageTitle: page.title,
        confluencePageVersion: page.version,
        confluencePageSize: page.sizeBytes,
      },
    });
    nextSyncedPages[page.id] = page.version;
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
    contentHash: hashContent(candidates.map((candidate) => `${candidate.id}:${candidate.version}`).join("\n")),
    metadata: JSON.stringify({
      ...metadata,
      confluenceSyncedPages: nextSyncedPages,
      confluenceLastSync: {
        checkedAt: now.toISOString(),
        matchedPages: candidates.length,
        changedPages: changedCandidates.length,
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

  if (sourceRow.type === "s3_bucket") {
    const now = new Date();
    try {
      return await syncS3ContextSource(db, tenantId, sourceRow, collection, options);
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

  if (sourceRow.type === "confluence_space") {
    const now = new Date();
    try {
      return await syncConfluenceContextSource(db, tenantId, sourceRow, collection, options);
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
    const metadata = parseMetadata(sourceRow.metadata);
    const file = sourceRow.type === "file_upload" && typeof metadata.file === "object" && metadata.file !== null && !Array.isArray(metadata.file)
      ? metadata.file as Record<string, unknown>
      : null;
    const title = typeof file?.filename === "string" && file.filename.trim() ? file.filename.trim() : sourceRow.name;
    const result = await ingestContextDocument(db, tenantId, sourceRow.collectionId, {
      title,
      text: sourceRow.content,
      source: `source:${sourceRow.type}`,
      sourceUri: sourceRow.sourceUri ?? undefined,
      metadata: {
        ...metadata,
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
