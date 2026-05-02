import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextOptimizerPanel } from "../src/components/context-optimizer-panel";
import { gatewayFetchRaw } from "../src/lib/gateway-client";

vi.mock("../src/lib/gateway-client", () => ({
  gatewayFetchRaw: vi.fn(),
}));

const mockedFetch = vi.mocked(gatewayFetchRaw);

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("ContextOptimizerPanel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    window.localStorage.clear();
  });

  it("renders summary metrics and recent events", async () => {
    mockedFetch.mockImplementation((path) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 2,
            inputChunks: 10,
            outputChunks: 7,
            droppedChunks: 3,
            nearDuplicateChunks: 1,
            inputTokens: 1000,
            outputTokens: 730,
            savedTokens: 270,
            reductionPct: 27,
            avgRelevanceScore: 0.61,
            lowRelevanceChunks: 2,
            rerankedChunks: 4,
            avgFreshnessScore: 0.72,
            staleChunks: 2,
            conflictChunks: 2,
            conflictGroups: 1,
            compressedChunks: 3,
            compressionSavedTokens: 120,
            compressionRatePct: 12,
            flaggedChunks: 1,
            quarantinedChunks: 2,
            latestAt: "2026-05-01T21:00:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 3,
            regressedCount: 1,
            avgRawScore: 4.2,
            avgOptimizedScore: 4,
            avgDelta: -0.2,
            latestAt: "2026-05-01T21:30:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/quality/events?limit=10") {
        return Promise.resolve(jsonResponse({
          events: [
            {
              id: "quality-1",
              tenantId: "tenant-pro",
              rawScore: 4,
              optimizedScore: 3,
              delta: -1,
              regressed: true,
              regressionThreshold: -0.5,
              judgeProvider: "openai",
              judgeModel: "gpt-4o-mini",
              promptHash: "abc123",
              rawSourceIds: ["refunds#1", "policy#2"],
              optimizedSourceIds: ["refunds#1"],
              rationale: "Optimized answer omitted one detail.",
              createdAt: "2026-05-01T21:30:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 2,
            retrievedChunks: 10,
            usedChunks: 6,
            unusedChunks: 4,
            duplicateChunks: 2,
            nearDuplicateChunks: 1,
            riskyChunks: 1,
            retrievedTokens: 1000,
            usedTokens: 620,
            unusedTokens: 380,
            avgRelevanceScore: 0.61,
            lowRelevanceChunks: 2,
            rerankedChunks: 4,
            avgFreshnessScore: 0.72,
            staleChunks: 2,
            conflictChunks: 2,
            conflictGroups: 1,
            compressedChunks: 3,
            compressionSavedTokens: 120,
            compressionRatePct: 12,
            efficiencyPct: 62,
            duplicateRatePct: 20,
            nearDuplicateRatePct: 10,
            riskyRatePct: 10,
            conflictRatePct: 20,
            latestAt: "2026-05-01T21:45:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/retrieval/events?limit=10") {
        return Promise.resolve(jsonResponse({
          events: [
            {
              id: "retrieval-1",
              tenantId: "tenant-pro",
              optimizationEventId: "evt-1",
              retrievedChunks: 5,
              usedChunks: 3,
              unusedChunks: 2,
              duplicateChunks: 1,
              nearDuplicateChunks: 1,
              riskyChunks: 1,
              retrievedTokens: 500,
              usedTokens: 300,
              unusedTokens: 200,
              avgRelevanceScore: 0.58,
              lowRelevanceChunks: 1,
              rerankedChunks: 2,
              avgFreshnessScore: 0.66,
              staleChunks: 1,
              conflictChunks: 2,
              conflictGroups: 1,
              compressedChunks: 2,
              compressionSavedTokens: 80,
              compressionRatePct: 16,
              efficiencyPct: 60,
              duplicateRatePct: 20,
              nearDuplicateRatePct: 20,
              riskyRatePct: 20,
              conflictRatePct: 40,
              usedSourceIds: ["chunk-a", "chunk-b", "chunk-c"],
              unusedSourceIds: ["chunk-c", "chunk-risky"],
              riskySourceIds: ["chunk-risky"],
              conflictSourceIds: ["chunk-a", "chunk-c"],
              createdAt: "2026-05-01T21:45:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/collections") {
        return Promise.resolve(jsonResponse({
          collections: [
            {
              id: "collection-1",
              tenantId: "tenant-pro",
              name: "Support KB",
              description: "Approved support context",
              status: "active",
              documentCount: 2,
              blockCount: 8,
              canonicalBlockCount: 5,
              approvedBlockCount: 3,
              tokenCount: 1400,
              createdAt: "2026-05-01T20:00:00.000Z",
              updatedAt: "2026-05-01T22:00:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/credentials") {
        return Promise.resolve(jsonResponse({
          credentials: [
            {
              id: "cred-1",
              tenantId: "tenant-pro",
              name: "GitHub Docs",
              type: "github_token",
              hasSecret: true,
              lastUsedAt: "2026-05-01T22:04:00.000Z",
              createdAt: "2026-05-01T20:00:00.000Z",
              updatedAt: "2026-05-01T22:04:00.000Z",
            },
            {
              id: "cred-aws",
              tenantId: "tenant-pro",
              name: "AWS Docs",
              type: "aws_access_key",
              hasSecret: true,
              lastUsedAt: null,
              createdAt: "2026-05-01T20:00:00.000Z",
              updatedAt: "2026-05-01T22:04:00.000Z",
            },
            {
              id: "cred-confluence",
              tenantId: "tenant-pro",
              name: "Confluence Docs",
              type: "confluence_api_token",
              hasSecret: true,
              lastUsedAt: null,
              createdAt: "2026-05-01T20:00:00.000Z",
              updatedAt: "2026-05-01T22:04:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/collections/collection-1/canonical-blocks?reviewStatus=draft") {
        return Promise.resolve(jsonResponse({
          canonicalBlocks: [
            {
              id: "canonical-1",
              collectionId: "collection-1",
              content: "Refunds require a receipt within 30 days.",
              tokenCount: 8,
              sourceCount: 2,
              reviewStatus: "draft",
              reviewNote: null,
              reviewedByUserId: null,
              reviewedAt: null,
              policyStatus: "failed",
              policyCheckedAt: "2026-05-01T22:04:00.000Z",
              policyDetails: [
                {
                  decision: "quarantine",
                  ruleId: "rule-injection",
                  ruleName: "Prompt injection firewall",
                  action: "block",
                  matchedSnippet: "ignore previous instructions",
                },
              ],
              updatedAt: "2026-05-01T22:05:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/collections/collection-1/sources") {
        return Promise.resolve(jsonResponse({
          sources: [
            {
              id: "source-1",
              collectionId: "collection-1",
              name: "Refund source",
              type: "manual",
              externalId: "refunds.md",
              sourceUri: "file://refunds.md",
              syncStatus: "synced",
              lastSyncedAt: "2026-05-01T22:03:00.000Z",
              lastDocumentId: "doc-1",
              documentCount: 1,
              lastError: null,
              metadata: {},
              updatedAt: "2026-05-01T22:03:00.000Z",
            },
            {
              id: "source-2",
              collectionId: "collection-1",
              name: "Docs repository",
              type: "github_repository",
              externalId: "github:acme/docs:main:docs",
              sourceUri: "https://github.com/acme/docs/tree/main",
              syncStatus: "synced",
              lastSyncedAt: "2026-05-01T22:04:00.000Z",
              lastDocumentId: "doc-2",
              documentCount: 2,
              lastError: null,
              metadata: { github: { owner: "acme", repo: "docs", branch: "main", path: "docs", credentialId: "cred-1" } },
              updatedAt: "2026-05-01T22:04:00.000Z",
            },
            {
              id: "source-3",
              collectionId: "collection-1",
              name: "Uploaded handbook",
              type: "file_upload",
              externalId: "upload:handbook",
              sourceUri: "upload://handbook.md",
              syncStatus: "pending",
              lastSyncedAt: null,
              lastDocumentId: null,
              documentCount: 0,
              lastError: null,
              metadata: { file: { filename: "handbook.md", contentType: "text/markdown", sizeBytes: 128 } },
              updatedAt: "2026-05-01T22:05:00.000Z",
            },
            {
              id: "source-4",
              collectionId: "collection-1",
              name: "Docs bucket",
              type: "s3_bucket",
              externalId: "s3:acme-docs:us-east-1:docs",
              sourceUri: "s3://acme-docs/docs",
              syncStatus: "synced",
              lastSyncedAt: "2026-05-01T22:06:00.000Z",
              lastDocumentId: "doc-s3",
              documentCount: 2,
              lastError: null,
              metadata: { s3: { bucket: "acme-docs", region: "us-east-1", prefix: "docs", credentialId: "cred-aws" } },
              updatedAt: "2026-05-01T22:06:00.000Z",
            },
            {
              id: "source-5",
              collectionId: "collection-1",
              name: "Support space",
              type: "confluence_space",
              externalId: "confluence:https://acme.atlassian.net:SUP:policy:",
              sourceUri: "https://acme.atlassian.net/wiki/spaces/SUP",
              syncStatus: "synced",
              lastSyncedAt: "2026-05-01T22:07:00.000Z",
              lastDocumentId: "doc-confluence",
              documentCount: 2,
              lastError: null,
              metadata: { confluence: { baseUrl: "https://acme.atlassian.net", spaceKey: "SUP", labels: ["policy"], credentialId: "cred-confluence" } },
              updatedAt: "2026-05-01T22:07:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/canonical-blocks/bulk-policy-check") {
        return Promise.resolve(jsonResponse({
          results: [
            {
              id: "canonical-1",
              ok: true,
              canonicalBlock: {
                id: "canonical-1",
                collectionId: "collection-1",
                content: "Refunds require a receipt within 30 days.",
                tokenCount: 8,
                sourceCount: 2,
                reviewStatus: "draft",
                reviewNote: null,
                reviewedByUserId: null,
                reviewedAt: null,
                policyStatus: "passed",
                policyCheckedAt: "2026-05-01T22:06:00.000Z",
                policyDetails: [{ decision: "allow", ruleId: null, ruleName: null, action: null, matchedSnippet: null }],
                updatedAt: "2026-05-01T22:06:00.000Z",
              },
              policy: { status: "passed", decision: "allow", violations: [] },
            },
          ],
        }));
      }
      if (path === "/v1/context/canonical-blocks/bulk-review") {
        return Promise.resolve(jsonResponse({
          results: [
            {
              id: "canonical-1",
              ok: true,
              canonicalBlock: { id: "canonical-1", reviewStatus: "approved" },
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({
        events: [
          {
            id: "evt-1",
            tenantId: "tenant-pro",
            inputChunks: 5,
            outputChunks: 3,
            droppedChunks: 2,
            nearDuplicateChunks: 1,
            inputTokens: 500,
            outputTokens: 300,
            savedTokens: 200,
            reductionPct: 40,
            avgRelevanceScore: 0.58,
            lowRelevanceChunks: 1,
            rerankedChunks: 2,
            avgFreshnessScore: 0.66,
            staleChunks: 1,
            conflictChunks: 2,
            conflictGroups: 1,
            compressedChunks: 2,
            compressionSavedTokens: 80,
            compressionRatePct: 16,
            conflictSourceIds: ["chunk-a", "chunk-c"],
            conflictDetails: [
              {
                id: "conflict-1",
                kind: "numeric",
                chunkIds: ["chunk-a", "chunk-c"],
                sourceIds: ["chunk-a", "chunk-c"],
                topicTokens: ["refund", "window"],
                leftValue: "30 days",
                rightValue: "14 days",
                score: 0.76,
                severity: "medium",
              },
            ],
            duplicateSourceIds: ["chunk-b"],
            nearDuplicateSourceIds: ["chunk-c"],
            riskScanned: true,
            flaggedChunks: 1,
            quarantinedChunks: 1,
            riskySourceIds: ["chunk-risky"],
            riskDetails: [
              {
                id: "chunk-risky",
                decision: "quarantine",
                ruleName: "Context injection",
                matchedContent: "ignore previous instructions",
              },
            ],
            createdAt: "2026-05-01T21:00:00.000Z",
          },
        ],
      }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Context Optimizer")).toBeInTheDocument();
    expect(screen.getByText("270")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(document.body.textContent).toContain('"rankMode": "embedding"');
    expect(screen.getByText("10 input chunks scanned")).toBeInTheDocument();
    expect(screen.getByText("27%")).toBeInTheDocument();
    expect(screen.getByText("chunk-b")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-c").length).toBeGreaterThan(0);
    expect(screen.getByText("Risky Chunks")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-risky").length).toBeGreaterThan(0);
    expect(screen.getByText("Quality Delta")).toBeInTheDocument();
    expect(screen.getByText("Regression")).toBeInTheDocument();
    expect(screen.getByText("refunds#1")).toBeInTheDocument();
    expect(screen.getByText("Retrieval Efficiency")).toBeInTheDocument();
    expect(screen.getByText("Unused Context")).toBeInTheDocument();
    expect(screen.getAllByText("Relevance").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Freshness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Conflicts").length).toBeGreaterThan(0);
    expect(screen.getByText(/medium 0.76/i)).toBeInTheDocument();
    expect(screen.getByText("Conflict Rate")).toBeInTheDocument();
    expect(screen.getAllByText("Compression").length).toBeGreaterThan(0);
    expect(screen.getByText("Semantic Rate")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-risky").length).toBeGreaterThan(0);
    expect(screen.getByText("Managed Collections")).toBeInTheDocument();
    expect(screen.getByText("Support KB")).toBeInTheDocument();
    expect(screen.getByText("Approved support context")).toBeInTheDocument();
    expect(screen.getByText("Connector Management")).toBeInTheDocument();
    expect(screen.getByText("GitHub Token Credentials")).toBeInTheDocument();
    expect(screen.getByText("GitHub Source")).toBeInTheDocument();
    expect(screen.getAllByText("GitHub Docs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AWS Docs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stored").length).toBeGreaterThan(0);
    expect(screen.getByText("Collection Sources")).toBeInTheDocument();
    expect(screen.getByText("Refund source")).toBeInTheDocument();
    expect(screen.getByText("file://refunds.md")).toBeInTheDocument();
    expect(screen.getByText("Docs repository")).toBeInTheDocument();
    expect(screen.getByText("acme/docs@main/docs")).toBeInTheDocument();
    expect(screen.getByText("Uploaded handbook")).toBeInTheDocument();
    expect(screen.getByText("handbook.md (text/markdown, 128 bytes)")).toBeInTheDocument();
    expect(screen.getByText("Docs bucket")).toBeInTheDocument();
    expect(screen.getByText("s3://acme-docs/docs (us-east-1)")).toBeInTheDocument();
    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
    expect(screen.getByText("Canonical")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Canonical Review Queue")).toBeInTheDocument();
    expect(screen.getByText("Refunds require a receipt within 30 days.")).toBeInTheDocument();
    expect(screen.getByText("Prompt injection firewall: ignore previous instructions")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select canonical block canonical-1"));
    fireEvent.click(screen.getByText("Run Policy Check"));
    expect(await screen.findByText("Policy checks complete: 1 updated, 0 failed.")).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByText("Bulk approved: 1 updated, 0 failed.")).toBeInTheDocument();
    expect(screen.getByText("No draft canonical blocks in the first managed collection.")).toBeInTheDocument();
  });

  it("creates GitHub credentials, creates sources, and syncs source rows without rendering secrets", async () => {
    mockedFetch.mockImplementation((path, init) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            inputChunks: 0,
            outputChunks: 0,
            droppedChunks: 0,
            nearDuplicateChunks: 0,
            inputTokens: 0,
            outputTokens: 0,
            savedTokens: 0,
            reductionPct: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            flaggedChunks: 0,
            quarantinedChunks: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            regressedCount: 0,
            avgRawScore: null,
            avgOptimizedScore: null,
            avgDelta: null,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            retrievedChunks: 0,
            usedChunks: 0,
            unusedChunks: 0,
            duplicateChunks: 0,
            nearDuplicateChunks: 0,
            riskyChunks: 0,
            retrievedTokens: 0,
            usedTokens: 0,
            unusedTokens: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            efficiencyPct: 0,
            duplicateRatePct: 0,
            nearDuplicateRatePct: 0,
            riskyRatePct: 0,
            conflictRatePct: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/collections") {
        return Promise.resolve(jsonResponse({
          collections: [
            {
              id: "collection-1",
              tenantId: "tenant-pro",
              name: "Support KB",
              description: "Approved support context",
              status: "active",
              documentCount: 0,
              blockCount: 0,
              canonicalBlockCount: 0,
              approvedBlockCount: 0,
              tokenCount: 0,
              createdAt: "2026-05-01T20:00:00.000Z",
              updatedAt: "2026-05-01T20:00:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/credentials" && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (parsed.type === "aws_access_key") {
          const value = JSON.parse(String(parsed.value)) as Record<string, unknown>;
          expect(parsed).toMatchObject({
            name: "AWS token",
            type: "aws_access_key",
          });
          expect(value).toMatchObject({
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "aws_secret_123",
          });
          return Promise.resolve(jsonResponse({
            credential: {
              id: "cred-aws-new",
              tenantId: "tenant-pro",
              name: "AWS token",
              type: "aws_access_key",
              hasSecret: true,
              lastUsedAt: null,
              createdAt: "2026-05-01T22:10:00.000Z",
              updatedAt: "2026-05-01T22:10:00.000Z",
            },
          }));
        }
        if (parsed.type === "confluence_api_token") {
          const value = JSON.parse(String(parsed.value)) as Record<string, unknown>;
          expect(parsed).toMatchObject({
            name: "Confluence token",
            type: "confluence_api_token",
          });
          expect(value).toMatchObject({
            email: "docs@example.com",
            apiToken: "conf_secret_123",
          });
          return Promise.resolve(jsonResponse({
            credential: {
              id: "cred-confluence-new",
              tenantId: "tenant-pro",
              name: "Confluence token",
              type: "confluence_api_token",
              hasSecret: true,
              lastUsedAt: null,
              createdAt: "2026-05-01T22:10:00.000Z",
              updatedAt: "2026-05-01T22:10:00.000Z",
            },
          }));
        }
        expect(parsed).toMatchObject({
          name: "Docs token",
          type: "github_token",
          value: "ghp_secret_token_123",
        });
        return Promise.resolve(jsonResponse({
          credential: {
            id: "cred-new",
            tenantId: "tenant-pro",
            name: "Docs token",
            type: "github_token",
            hasSecret: true,
            lastUsedAt: null,
            createdAt: "2026-05-01T22:10:00.000Z",
            updatedAt: "2026-05-01T22:10:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/credentials") {
        return Promise.resolve(jsonResponse({ credentials: [] }));
      }
      if (path === "/v1/context/collections/collection-1/sources" && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (parsed.type === "file_upload") {
          expect(parsed).toMatchObject({
            name: "Uploaded guide",
            type: "file_upload",
            content: "Uploaded guide content for context.",
            file: {
              filename: "guide.md",
              contentType: "text/markdown",
            },
          });
          return Promise.resolve(jsonResponse({
            source: {
              id: "source-file",
              collectionId: "collection-1",
              name: "Uploaded guide",
              type: "file_upload",
              externalId: "upload:guide",
              sourceUri: "upload://guide.md",
              syncStatus: "pending",
              lastSyncedAt: null,
              lastDocumentId: null,
              documentCount: 0,
              lastError: null,
              metadata: { file: { filename: "guide.md", contentType: "text/markdown", sizeBytes: 35 } },
              updatedAt: "2026-05-01T22:10:00.000Z",
            },
          }));
        }
        if (parsed.type === "s3_bucket") {
          expect(parsed).toMatchObject({
            name: "Docs bucket",
            type: "s3_bucket",
            s3: {
              bucket: "acme-docs",
              region: "us-east-1",
              prefix: "docs",
              credentialId: "cred-aws-new",
              extensions: [".md", ".txt"],
              maxFiles: 25,
              maxFileBytes: 125000,
            },
          });
          return Promise.resolve(jsonResponse({
            source: {
              id: "source-s3",
              collectionId: "collection-1",
              name: "Docs bucket",
              type: "s3_bucket",
              externalId: "s3:acme-docs:us-east-1:docs",
              sourceUri: "s3://acme-docs/docs",
              syncStatus: "pending",
              lastSyncedAt: null,
              lastDocumentId: null,
              documentCount: 0,
              lastError: null,
              metadata: { s3: { bucket: "acme-docs", region: "us-east-1", prefix: "docs", credentialId: "cred-aws-new" } },
              updatedAt: "2026-05-01T22:10:00.000Z",
            },
          }));
        }
        if (parsed.type === "confluence_space") {
          expect(parsed).toMatchObject({
            name: "Support space",
            type: "confluence_space",
            confluence: {
              baseUrl: "https://acme.atlassian.net",
              spaceKey: "SUP",
              labels: ["policy"],
              titleContains: "Refund",
              credentialId: "cred-confluence-new",
              maxPages: 25,
              maxPageBytes: 125000,
            },
          });
          return Promise.resolve(jsonResponse({
            source: {
              id: "source-confluence",
              collectionId: "collection-1",
              name: "Support space",
              type: "confluence_space",
              externalId: "confluence:https://acme.atlassian.net:SUP:policy:Refund",
              sourceUri: "https://acme.atlassian.net/wiki/spaces/SUP",
              syncStatus: "pending",
              lastSyncedAt: null,
              lastDocumentId: null,
              documentCount: 0,
              lastError: null,
              metadata: { confluence: { baseUrl: "https://acme.atlassian.net", spaceKey: "SUP", labels: ["policy"], titleContains: "Refund", credentialId: "cred-confluence-new" } },
              updatedAt: "2026-05-01T22:10:00.000Z",
            },
          }));
        }
        expect(parsed).toMatchObject({
          name: "Docs repo",
          type: "github_repository",
          github: {
            owner: "acme",
            repo: "docs",
            branch: "main",
            path: "docs",
            credentialId: "cred-new",
            extensions: [".md", ".mdx"],
            maxFiles: 50,
            maxFileBytes: 125000,
          },
        });
        return Promise.resolve(jsonResponse({
          source: {
            id: "source-new",
            collectionId: "collection-1",
            name: "Docs repo",
            type: "github_repository",
            externalId: "github:acme/docs:main:docs",
            sourceUri: "https://github.com/acme/docs/tree/main",
            syncStatus: "pending",
            lastSyncedAt: null,
            lastDocumentId: null,
            documentCount: 0,
            lastError: null,
            metadata: { github: { owner: "acme", repo: "docs", branch: "main", path: "docs", credentialId: "cred-new" } },
            updatedAt: "2026-05-01T22:11:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/collections/collection-1/sources") {
        return Promise.resolve(jsonResponse({ sources: [] }));
      }
      if (path === "/v1/context/sources/source-new/sync") {
        return Promise.resolve(jsonResponse({
          synced: true,
          collection: {
            id: "collection-1",
            tenantId: "tenant-pro",
            name: "Support KB",
            description: "Approved support context",
            status: "active",
            documentCount: 1,
            blockCount: 3,
            canonicalBlockCount: 1,
            approvedBlockCount: 0,
            tokenCount: 250,
            createdAt: "2026-05-01T20:00:00.000Z",
            updatedAt: "2026-05-01T22:12:00.000Z",
          },
          source: {
            id: "source-new",
            collectionId: "collection-1",
            name: "Docs repo",
            type: "github_repository",
            externalId: "github:acme/docs:main:docs",
            sourceUri: "https://github.com/acme/docs/tree/main",
            syncStatus: "synced",
            lastSyncedAt: "2026-05-01T22:12:00.000Z",
            lastDocumentId: "doc-new",
            documentCount: 1,
            lastError: null,
            metadata: { github: { owner: "acme", repo: "docs", branch: "main", path: "docs", credentialId: "cred-new" } },
            updatedAt: "2026-05-01T22:12:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/sources/source-file/sync") {
        return Promise.resolve(jsonResponse({
          synced: true,
          collection: {
            id: "collection-1",
            tenantId: "tenant-pro",
            name: "Support KB",
            description: "Approved support context",
            status: "active",
            documentCount: 2,
            blockCount: 4,
            canonicalBlockCount: 1,
            approvedBlockCount: 0,
            tokenCount: 300,
            createdAt: "2026-05-01T20:00:00.000Z",
            updatedAt: "2026-05-01T22:13:00.000Z",
          },
          source: {
            id: "source-file",
            collectionId: "collection-1",
            name: "Uploaded guide",
            type: "file_upload",
            externalId: "upload:guide",
            sourceUri: "upload://guide.md",
            syncStatus: "synced",
            lastSyncedAt: "2026-05-01T22:13:00.000Z",
            lastDocumentId: "doc-file",
            documentCount: 1,
            lastError: null,
            metadata: { file: { filename: "guide.md", contentType: "text/markdown", sizeBytes: 35 } },
            updatedAt: "2026-05-01T22:13:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/sources/source-s3/sync") {
        return Promise.resolve(jsonResponse({
          synced: true,
          collection: {
            id: "collection-1",
            tenantId: "tenant-pro",
            name: "Support KB",
            description: "Approved support context",
            status: "active",
            documentCount: 3,
            blockCount: 6,
            canonicalBlockCount: 1,
            approvedBlockCount: 0,
            tokenCount: 400,
            createdAt: "2026-05-01T20:00:00.000Z",
            updatedAt: "2026-05-01T22:14:00.000Z",
          },
          source: {
            id: "source-s3",
            collectionId: "collection-1",
            name: "Docs bucket",
            type: "s3_bucket",
            externalId: "s3:acme-docs:us-east-1:docs",
            sourceUri: "s3://acme-docs/docs",
            syncStatus: "synced",
            lastSyncedAt: "2026-05-01T22:14:00.000Z",
            lastDocumentId: "doc-s3",
            documentCount: 2,
            lastError: null,
            metadata: { s3: { bucket: "acme-docs", region: "us-east-1", prefix: "docs", credentialId: "cred-aws-new" } },
            updatedAt: "2026-05-01T22:14:00.000Z",
          },
        }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Connector Management")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Credential Name"), { target: { value: "Docs token" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "ghp_secret_token_123" } });
    fireEvent.click(screen.getByText("Save Credential"));

    expect(await screen.findByText("Credential saved.")).toBeInTheDocument();
    expect(screen.getAllByText("Docs token").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("ghp_secret_token_123");

    fireEvent.change(screen.getByLabelText("AWS Credential Name"), { target: { value: "AWS token" } });
    fireEvent.change(screen.getByLabelText("Access Key ID"), { target: { value: "AKIA_TEST" } });
    fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "aws_secret_123" } });
    fireEvent.click(screen.getByText("Save AWS Credential"));

    expect(await screen.findByText("AWS credential saved.")).toBeInTheDocument();
    expect(screen.getAllByText("AWS token").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("aws_secret_123");

    fireEvent.change(screen.getByLabelText("Confluence Credential Name"), { target: { value: "Confluence token" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "docs@example.com" } });
    fireEvent.change(screen.getByLabelText("API Token"), { target: { value: "conf_secret_123" } });
    fireEvent.click(screen.getByText("Save Confluence Credential"));

    expect(await screen.findByText("Confluence credential saved.")).toBeInTheDocument();
    expect(screen.getAllByText("Confluence token").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("conf_secret_123");

    const upload = new File(["Uploaded guide content for context."], "guide.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [upload] } });
    expect(await screen.findByText("File loaded.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("guide")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Uploaded guide content for context.");
    fireEvent.change(screen.getByLabelText("File Source Name"), { target: { value: "Uploaded guide" } });
    fireEvent.click(screen.getByText("Create File Source"));

    expect(await screen.findByText("File source created.")).toBeInTheDocument();
    expect(screen.getByText("guide.md (text/markdown, 35 bytes)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Uploaded guide content for context.");

    fireEvent.change(screen.getByLabelText("S3 Source Name"), { target: { value: "Docs bucket" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "acme-docs" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("S3 Extensions"), { target: { value: ".md,.txt" } });
    fireEvent.change(screen.getByLabelText("S3 Max Files"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("S3 Max Bytes"), { target: { value: "125000" } });
    fireEvent.click(screen.getByText("Create S3 Source"));

    expect(await screen.findByText("S3 source created.")).toBeInTheDocument();
    expect(screen.getAllByText("s3://acme-docs/docs (us-east-1)").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Confluence Source Name"), { target: { value: "Support space" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://acme.atlassian.net" } });
    fireEvent.change(screen.getByLabelText("Space Key"), { target: { value: "SUP" } });
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: "policy" } });
    fireEvent.change(screen.getByLabelText("Title Filter"), { target: { value: "Refund" } });
    fireEvent.change(screen.getByLabelText("Max Pages"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Confluence Max Bytes"), { target: { value: "125000" } });
    fireEvent.click(screen.getByText("Create Confluence Source"));

    expect(await screen.findByText("Confluence source created.")).toBeInTheDocument();
    expect(screen.getAllByText("https://acme.atlassian.net/wiki/spaces/SUP (policy)").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("GitHub Source Name"), { target: { value: "Docs repo" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Extensions"), { target: { value: ".md,.mdx" } });
    fireEvent.change(screen.getByLabelText("Max Files"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Max Bytes"), { target: { value: "125000" } });
    fireEvent.click(screen.getByText("Create Source"));

    expect(await screen.findByText("GitHub source created.")).toBeInTheDocument();
    expect(screen.getByText("acme/docs@main/docs")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Sync" })[0] as HTMLElement);
    expect(await screen.findByText("Sync complete.")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    expect(screen.getByText("synced")).toBeInTheDocument();
  });

  it("updates and persists optimizer payload controls", async () => {
    mockedFetch.mockImplementation((path) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            inputChunks: 0,
            outputChunks: 0,
            droppedChunks: 0,
            nearDuplicateChunks: 0,
            inputTokens: 0,
            outputTokens: 0,
            savedTokens: 0,
            reductionPct: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            flaggedChunks: 0,
            quarantinedChunks: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            regressedCount: 0,
            avgRawScore: null,
            avgOptimizedScore: null,
            avgDelta: null,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            retrievedChunks: 0,
            usedChunks: 0,
            unusedChunks: 0,
            duplicateChunks: 0,
            nearDuplicateChunks: 0,
            riskyChunks: 0,
            retrievedTokens: 0,
            usedTokens: 0,
            unusedTokens: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            efficiencyPct: 0,
            duplicateRatePct: 0,
            nearDuplicateRatePct: 0,
            riskyRatePct: 0,
            conflictRatePct: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/collections") {
        return Promise.resolve(jsonResponse({ collections: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Configuration")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Ranking"), { target: { value: "lexical" } });
    fireEvent.change(screen.getByLabelText("Conflicts"), { target: { value: "heuristic" } });
    fireEvent.change(screen.getByLabelText("Max Sentences"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("Risk Scan"));

    expect(document.body.textContent).toContain('"rankMode": "lexical"');
    expect(document.body.textContent).toContain('"conflictMode": "heuristic"');
    expect(document.body.textContent).toContain('"maxSentencesPerChunk": 5');
    expect(document.body.textContent).toContain('"scanRisk": false');
    await waitFor(() => {
      expect(window.localStorage.getItem("provara:context-optimizer:settings")).toContain('"rankMode":"lexical"');
    });
  });

  it("shows the empty state", async () => {
    mockedFetch.mockImplementation((path) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            inputChunks: 0,
            outputChunks: 0,
            droppedChunks: 0,
            nearDuplicateChunks: 0,
            inputTokens: 0,
            outputTokens: 0,
            savedTokens: 0,
            reductionPct: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            flaggedChunks: 0,
            quarantinedChunks: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            regressedCount: 0,
            avgRawScore: null,
            avgOptimizedScore: null,
            avgDelta: null,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/events?limit=10") {
        return Promise.resolve(jsonResponse({ events: [] }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            retrievedChunks: 0,
            usedChunks: 0,
            unusedChunks: 0,
            duplicateChunks: 0,
            nearDuplicateChunks: 0,
            riskyChunks: 0,
            retrievedTokens: 0,
            usedTokens: 0,
            unusedTokens: 0,
            avgRelevanceScore: null,
            lowRelevanceChunks: 0,
            rerankedChunks: 0,
            avgFreshnessScore: null,
            staleChunks: 0,
            conflictChunks: 0,
            conflictGroups: 0,
            compressedChunks: 0,
            compressionSavedTokens: 0,
            compressionRatePct: 0,
            efficiencyPct: 0,
            duplicateRatePct: 0,
            nearDuplicateRatePct: 0,
            riskyRatePct: 0,
            conflictRatePct: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/retrieval/events?limit=10") {
        return Promise.resolve(jsonResponse({ events: [] }));
      }
      if (path === "/v1/context/collections") {
        return Promise.resolve(jsonResponse({ collections: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("No context optimization events yet.")).toBeInTheDocument();
    expect(screen.getByText("No context quality checks yet.")).toBeInTheDocument();
    expect(screen.getByText("No context retrieval events yet.")).toBeInTheDocument();
    expect(screen.getByText("No managed context collections yet.")).toBeInTheDocument();
  });

  it("shows upgrade messaging for gated tenants", async () => {
    mockedFetch.mockResolvedValue(jsonResponse({
      error: { message: "Your current plan does not include this feature." },
      gate: { upgradeUrl: "https://provara.xyz/dashboard/billing" },
    }, { status: 402 }));

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Upgrade required")).toBeInTheDocument();
    expect(screen.getByText("Your current plan does not include this feature.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Billing" })).toHaveAttribute(
      "href",
      "https://provara.xyz/dashboard/billing",
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("/v1/context/summary"));
  });
});
