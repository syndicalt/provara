# Context Optimizer

Context Optimizer is Provara's runtime visibility and optimization layer for retrieved context in RAG and agentic systems. It reduces duplicate context before provider routing and records the savings so teams can inspect what changed.

## Current Scope

The shipped V1 implementation is intentionally narrow:

- Exact duplicate detection after whitespace normalization and case folding.
- Optional semantic near-duplicate detection with deterministic token similarity.
- Optional lexical relevance scoring and reranking for retained chunks.
- Optional embedding-backed relevance scoring and reranking with lexical fallback.
- Optional stale-context detection from bounded freshness metadata.
- Optional conflicting-context detection with bounded heuristic claim checks and scored severity bands.
- Optional extractive compression with bounded sentence selection.
- Optional abstractive compression with provider summaries and mechanical fallback.
- Source ID preservation when duplicate chunks are dropped.
- Estimated token savings based on input and output context size.
- Optional risk scanning with active Guardrails rules for retrieved context.
- Flagged and quarantined context buckets with rule evidence and source IDs.
- Raw-context vs optimized-context quality scoring with the configured judge model.
- Retrieval analytics for used, unused, duplicate, and risky retrieved chunks.
- Managed context collections with plain-text ingestion into reusable blocks.
- Connector ingestion with tenant-scoped manual, file upload, GitHub repository, S3 bucket, and Confluence space sources plus encrypted connector credentials.
- Canonical context block distillation with review status and approved-only export.
- Canonical review audit events with reviewer notes and actor attribution when available.
- Tenant-scoped optimization events for reporting.
- Dashboard visibility at `/dashboard/context`.
- Dashboard configuration controls for composing and copying an optimization request payload.
- Dashboard connector management for GitHub credentials, AWS credentials, Confluence credentials, file upload source creation, S3 bucket source creation, Confluence space source creation, GitHub repository source creation, and manual source sync.

It does not yet perform connector pulls from systems such as Drive, SharePoint, Notion, or help centers. Those belong to later roadmap phases.

## API

Runtime optimization is available through:

```text
POST /v1/context/optimize
```

The request accepts already-retrieved context chunks:

```json
{
  "dedupeMode": "semantic",
  "semanticThreshold": 0.72,
  "rankMode": "embedding",
  "query": "What is the refund window?",
  "minRelevanceScore": 0.2,
  "freshnessMode": "metadata",
  "maxContextAgeDays": 180,
  "conflictMode": "scored",
  "compressionMode": "abstractive",
  "maxSentencesPerChunk": 3,
  "scanRisk": true,
  "chunks": [
    {
      "id": "doc-1:chunk-4",
      "content": "Refunds are available within 30 days.",
      "source": "help-center",
      "metadata": {
        "url": "https://example.com/refunds",
        "updatedAt": "2026-04-01T00:00:00.000Z"
      }
    },
    {
      "id": "doc-2:chunk-9",
      "content": "refunds are available within 30 days.",
      "source": "help-center-copy"
    }
  ]
}
```

The response includes:

- `optimization.optimized`: chunks retained for model context, optionally reranked, scored for relevance/freshness/conflicts, and compressed.
- `optimization.dropped`: exact duplicate and near-duplicate chunks removed from model context.
- `optimization.conflicts`: lightweight conflict groups found across retained chunks.
- `optimization.flagged`: risky chunks removed from model context but marked for operator review.
- `optimization.quarantined`: risky chunks removed from model context before provider routing.
- `optimization.metrics`: input/output chunk counts, estimated tokens, saved tokens, reduction percentage, relevance, freshness, conflict, and compression metrics.
- `event`: the persisted visibility record for the optimization call.
- `retrieval`: the persisted retrieval analytics record with efficiency, unused context, duplicate rate, risky context rate, conflict rate, and compression savings.

`dedupeMode` defaults to `exact` for backwards compatibility. Set `dedupeMode` to `semantic` to also remove near duplicates using deterministic token overlap scoring. `semanticThreshold` defaults to `0.72` and accepts values from `0.5` to `1`.

`rankMode` defaults to `none`. Set `rankMode` to `lexical` and provide `query` to score retained chunks with deterministic token matching and stable reranking. Set `rankMode` to `embedding` to score retained chunks by cosine similarity against the configured embedding provider. Embedding scoring bounds input text, batches chunk embeddings, stores aggregate relevance metrics only, and falls back to lexical scoring if embeddings are unavailable or fail. Provara does not persist the query text. `minRelevanceScore` defaults to `0.2` and controls the low-relevance chunk count.

`freshnessMode` defaults to `off`. Set `freshnessMode` to `metadata` to score retained chunks from bounded freshness metadata. Provara checks common fields such as `updatedAt`, `lastModified`, `publishedAt`, and `expiresAt`, stores aggregate freshness metrics only, and does not persist the full metadata payload. `maxContextAgeDays` defaults to `180`.

`conflictMode` defaults to `off`. Set `conflictMode` to `heuristic` to detect lightweight contradictions across retained chunks. Set `conflictMode` to `scored` to include bounded contradiction `score` values and `low`/`medium`/`high` severity bands on conflict groups and retained chunks. The detector uses local signals: shared metadata keys, status disagreements, and numeric claim disagreements such as different day/hour/percent/USD values on the same topic. It caps extracted signals and pair comparisons, so this stays deterministic and local; NLI-backed contradiction checks remain future paid-layer work.

`compressionMode` defaults to `off`. Set `compressionMode` to `extractive` to keep the highest-value sentences from retained chunks. The selector uses bounded sentence splitting, capped query tokens, stable local scoring, and preserves original sentence order in the compressed chunk. Set `compressionMode` to `abstractive` to summarize retained chunks through the configured provider; Provara preserves source IDs and token provenance, and falls back to extractive or original content if the model call fails, refuses, returns empty text, or increases token count. It records `compressedChunks`, `compressionSavedTokens`, and `compressionRatePct`. `maxSentencesPerChunk` defaults to `3` and accepts values from `1` to `8` for the extractive fallback.

`scanRisk` defaults to `false` for backwards compatibility. When enabled, Provara uses active Guardrails rules against the `retrieved_context` surface after duplicate removal. `flag` and `redact` actions become flagged context; `block` actions become quarantined context.

Visibility APIs:

```text
GET /v1/context/summary
GET /v1/context/events
GET /v1/context/quality/summary
GET /v1/context/quality/events
GET /v1/context/retrieval/summary
GET /v1/context/retrieval/events
```

These endpoints are tenant-scoped and require Intelligence access.

Managed collection APIs:

```text
GET /v1/context/collections
POST /v1/context/collections
POST /v1/context/collections/{id}/documents
GET /v1/context/collections/{id}/sources
POST /v1/context/collections/{id}/sources
GET /v1/context/credentials
POST /v1/context/credentials
POST /v1/context/sources/{id}/sync
POST /v1/context/collections/{id}/distill
GET /v1/context/collections/{id}/canonical-blocks
POST /v1/context/canonical-blocks/{id}/policy-check
POST /v1/context/canonical-blocks/bulk-policy-check
PATCH /v1/context/canonical-blocks/{id}/review
PATCH /v1/context/canonical-blocks/bulk-review
GET /v1/context/canonical-review-events
GET /v1/context/collections/{id}/export
```

Collections are tenant-scoped containers for reusable context. The document ingestion endpoint accepts plain text, source labels, source URIs, and metadata, then deterministically chunks the text into stored blocks with content hashes, token estimates, source provenance, and collection counters.

Manual sources are the connector foundation. `POST /v1/context/collections/{id}/sources` creates a tenant-scoped source with content, source URI, external ID, and metadata. `POST /v1/context/sources/{id}/sync` ingests that source into the existing `context_documents` and `context_blocks` pipeline, records `synced` or `failed` status on the source, persists the last error for failed syncs, and skips unchanged already-synced sources without duplicating documents.

File upload sources use `type: "file_upload"` with text content and a `file` metadata object:

```json
{
  "name": "Uploaded handbook",
  "type": "file_upload",
  "content": "# Refund policy\nRefunds require a receipt within 30 days.",
  "file": {
    "filename": "handbook.md",
    "contentType": "text/markdown"
  }
}
```

Upload ingestion is text-only and bounded to 500,000 UTF-8 bytes. Provara sanitizes the filename, stores file metadata on the source, uses an `upload://` source URI, and syncs the content through the same document/block pipeline as manual sources.

GitHub repository sources use `type: "github_repository"` with a `github` config object:

```json
{
  "name": "Docs repository",
  "type": "github_repository",
  "github": {
    "owner": "acme",
    "repo": "docs",
    "branch": "main",
    "path": "docs",
    "credentialId": "credential-id",
    "extensions": [".md", ".txt"],
    "maxFiles": 100,
    "maxFileBytes": 250000
  }
}
```

GitHub sync fetches the repository tree and selected blobs through GitHub's JSON API, bounds files by extension/count/size, stores repo/path/SHA metadata on ingested documents and blocks, and skips files whose blob SHA has already synced.

S3 bucket sources use `type: "s3_bucket"` with an `s3` config object:

```json
{
  "name": "Docs bucket",
  "type": "s3_bucket",
  "s3": {
    "bucket": "acme-docs",
    "region": "us-east-1",
    "prefix": "docs",
    "credentialId": "credential-id",
    "extensions": [".md", ".txt"],
    "maxFiles": 100,
    "maxFileBytes": 250000
  }
}
```

S3 sync uses AWS Signature Version 4 against S3 ListObjectsV2 and GetObject, bounds objects by extension/count/size, stores bucket/key/ETag metadata on ingested documents and blocks, and skips objects whose ETag has already synced.

Confluence space sources use `type: "confluence_space"` with a `confluence` config object:

```json
{
  "name": "Support space",
  "type": "confluence_space",
  "confluence": {
    "baseUrl": "https://acme.atlassian.net",
    "spaceKey": "SUP",
    "credentialId": "credential-id",
    "labels": ["policy"],
    "titleContains": "Refund",
    "maxPages": 100,
    "maxPageBytes": 250000
  }
}
```

Confluence sync uses the Confluence Cloud content search API, bounds pages by count and storage-body byte size, extracts text from storage HTML, stores space/page/version metadata on ingested documents and blocks, and skips pages whose version number has already synced.

Connector credentials are tenant-scoped encrypted secrets. `POST /v1/context/credentials` accepts `type: "github_token"` and a token `value`, `type: "aws_access_key"` with a JSON string containing `accessKeyId`, `secretAccessKey`, and optional `sessionToken`, or `type: "confluence_api_token"` with a JSON string containing `email` and `apiToken`. Values are stored with the same AES-GCM master-key encryption used for provider API keys, and responses return only metadata plus `hasSecret: true`. `GET /v1/context/credentials` never returns raw secret values. GitHub sources can set `github.credentialId`; S3 sources must set `s3.credentialId`; Confluence sources must set `confluence.credentialId`; sync decrypts the credential server-side and records missing or undecryptable credentials as failed source syncs.

Distillation converts stored blocks into canonical blocks through local normalization and hash-based coalescing. Duplicate stored blocks collapse into a single canonical block with multiple `sourceBlockIds` and `sourceDocumentIds`. Canonical blocks start in `draft`, can be marked `approved` or `rejected`, and the export endpoint returns only approved blocks for downstream retrieval/vector workflows.

Before a canonical block can be approved, `POST /v1/context/canonical-blocks/{id}/policy-check` runs active Guardrails rules against the block as `retrieved_context`. The result persists `policyStatus`, `policyCheckedAt`, and per-rule evidence. `block` and retrieved-context `quarantine` decisions set `policyStatus: "failed"` and approval returns `409 policy_error`; `draft` and `rejected` transitions remain available without a passing check.

Bulk review endpoints accept up to 100 `blockIds` and return per-block results. `POST /v1/context/canonical-blocks/bulk-policy-check` loads active Guardrails rules once, checks each selected block, and records pass/fail evidence independently. `PATCH /v1/context/canonical-blocks/bulk-review` updates selected blocks that pass validation and returns item-level `policy_error` or `not_found` failures without aborting the whole batch.

Context governance alerts use the existing Alerts workflow. Provara provisions default alert rules for `context_policy_failures`, `context_stale_drafts`, and `context_approved_export_delta`. Failed single or bulk policy checks append alert history with the canonical block ID and decision. The Alerts evaluator checks for draft canonical blocks that have stayed in review past the rule window and writes standard alert history entries.

Review updates accept an optional `note`, persist `reviewedAt`, and attach `reviewedByUserId` when the caller is a dashboard session user. Each status change also writes a tenant-scoped review event with from-status, to-status, note, actor, canonical block ID, collection ID, and timestamp.

Quality evaluation is available through:

```text
POST /v1/context/evaluate
```

The request accepts the same user prompt plus two already-produced answers:

```json
{
  "prompt": "What is the refund window?",
  "rawAnswer": "Refunds are available within 30 days and require a receipt.",
  "optimizedAnswer": "Refunds are available within 30 days.",
  "rawSourceIds": ["refunds.md#4", "policy.md#2"],
  "optimizedSourceIds": ["refunds.md#4"],
  "regressionThreshold": -0.5
}
```

The response includes the judge scores, optimized-minus-raw delta, regression flag, judge target, and persisted event. Provara stores a prompt hash, scores, source IDs, judge metadata, and rationale. It does not persist the full prompt, answers, or context content.

## Dashboard

The Context Optimizer dashboard lives at:

```text
/dashboard/context
```

It shows five summary cards:

- **Events**: number of optimization calls recorded for the tenant.
- **Saved Tokens**: estimated context tokens removed before provider routing.
- **Dropped Chunks**: duplicate chunks removed from model context.
- **Risky Chunks**: flagged and quarantined chunks removed by risk scanning.
- **Reduction**: saved tokens divided by estimated input tokens.

The Configuration section lets operators draft optimizer settings for `dedupeMode`, `rankMode`, `freshnessMode`, `conflictMode`, `compressionMode`, `scanRisk`, and related thresholds. The draft is stored in browser local storage and can be copied as a `POST /v1/context/optimize` JSON payload.

The Managed Collections section lists persisted context collections, including document count, stored block count, canonical block count, approved block count, estimated token count, status, and last update time. The Connector Management section can create GitHub token credentials, AWS access-key credentials, Confluence API-token credentials, list credential metadata without secret values, create text file upload sources, create S3 bucket sources, create Confluence space sources, create GitHub repository sources for the first managed collection, and bind external sources to stored credentials. The Collection Sources section shows manual, file upload, GitHub, S3, and Confluence sources for the first managed collection, including source URI, filename metadata, repo/branch/path, bucket/prefix/region, or Confluence base URL/space/labels, auth-configured status, sync status, document count, last synced time, update time, and last sync error. Operators can manually sync a source row from the dashboard. The Canonical Review Queue shows draft canonical blocks from the first managed collection with content, source count, token count, policy status, policy evidence, review status, and update time. Reviewers can select visible rows, run bulk policy checks, and approve or reject selected draft blocks from the dashboard. The Alerts dashboard surfaces context policy failures and stale review queue alerts alongside existing operational alert history. Collection creation, manual source ingestion, distillation, review, and export are available through the API in this release; richer in-dashboard collection management remains a follow-up.

The Recent Events table shows:

- Event time.
- Input chunks to output chunks.
- Dropped chunk count.
- Semantic near-duplicate count.
- Average relevance score and reranked chunk count.
- Average freshness score and stale chunk count.
- Risk scan result, including flagged and quarantined counts.
- Saved tokens and reduction percentage.
- Exact duplicate and near-duplicate source IDs that were removed.
- Risky source IDs that were flagged or quarantined.

The Quality Loop section shows:

- Average optimized-minus-raw quality delta.
- Number of raw-vs-optimized quality checks.
- Number of checks below the configured regression threshold.
- Recent quality events with raw score, optimized score, delta, status, source IDs, and judge target.

The Retrieval Analytics section shows:

- Retrieval efficiency: used context divided by retrieved context.
- Unused context count and token estimate.
- Duplicate rate.
- Semantic near-duplicate rate.
- Average relevance score, low-relevance chunk count, and reranked chunk count.
- Average freshness score and stale context count.
- Risky context rate.
- Recent retrieval events with used/retrieved chunks, relevance, freshness, duplicate/semantic/risky/conflict counts, conflict severity, and unused source IDs.

## Demo Mode

The public demo tenant (`t_demo`) seeds recent Context Optimizer events. This keeps `/dashboard/context` useful for demos, screenshots, and product walkthroughs without requiring a live RAG integration.

## Next Roadmap Step

The next behavior layer is additional external connector ingestion:

- Google Drive, SharePoint, Notion, and Zendesk/Intercom connectors.
- Connector-level review and policy defaults.
