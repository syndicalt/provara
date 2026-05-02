# Provara Context Optimizer Roadmap

## Product Thesis

Provara already controls the model path: routing, spend, quality, evals, guardrails, caching, and alerts. Context Optimizer adds the missing production layer for RAG and agentic systems: the context path.

The product goal is to make retrieved context cheaper, safer, more accurate, and measurable before it reaches the model.

## Shipped Checkpoint

Implemented as of `0.2.0`:
- `POST /v1/context/optimize` for runtime exact duplicate removal.
- Persisted `context_optimization_events`.
- Tenant-scoped `GET /v1/context/summary` and `GET /v1/context/events`.
- Dashboard visibility at `/dashboard/context`.
- Dashboard configuration controls for optimizer modes and copyable API payloads.
- Demo tenant seed data for screenshot-ready examples.
- Optional retrieved-context risk scanning with active Guardrails rules.
- Flagged and quarantined context reporting in API events and the dashboard.
- Raw-context vs optimized-context judge scoring through `POST /v1/context/evaluate`.
- `context_quality_events` with quality deltas, regression flags, source IDs, judge metadata, and dashboard visibility.
- `context_retrieval_events` with retrieval efficiency, unused context, duplicate rate, risky context rate, source IDs, and dashboard visibility.
- Optional semantic near-duplicate detection with separate near-duplicate event, summary, retrieval, and dashboard metrics.
- Optional lexical relevance scoring and stable reranking with aggregate relevance metrics and dashboard visibility.
- Optional embedding-backed relevance scoring and reranking with lexical fallback.
- Optional stale-context detection from freshness metadata with aggregate freshness metrics and dashboard visibility.
- Optional conflicting-context detection with bounded heuristic status/numeric/metadata checks and dashboard visibility.
- Optional scored contradiction severity bands for retained-context conflicts.
- Optional extractive compression with bounded sentence selection, compression savings metrics, and dashboard visibility.
- Optional abstractive compression with provider summaries, provenance preservation, and mechanical fallback.
- Dashboard configuration controls for drafting optimizer payloads.

Next planned layer:
- Persistent knowledge distillation and managed content stores.

## V1: Runtime Context Optimizer

Optimize already-retrieved chunks at request time.

Core capabilities:
- Exact duplicate removal.
- Optional semantic near-duplicate removal through deterministic token similarity.
- Optional lexical relevance scoring and reranking.
- Optional embedding-backed relevance scoring and reranking.
- Optional freshness scoring from chunk metadata.
- Optional conflict detection across retained chunks.
- Optional contradiction scoring and severity bands across retained chunks.
- Optional extractive compression for retained chunks.
- Optional abstractive compression for retained chunks.
- Token savings estimation.
- Source and citation preservation.
- Prompt Injection Firewall risk scanning for retrieved context.
- Per-request optimization report.

Initial API:
- `POST /v1/context/optimize`

Paid tier:
- Pro and higher through Intelligence access.

## V1.1: Visibility

Make optimization visible in the product.

Capabilities:
- Context savings analytics.
- Duplicate-rate reporting.
- Quarantined context reporting.
- Retrieval efficiency and unused-context reporting. Shipped in V1.2.
- Semantic near-duplicate reporting. Shipped in V1.2.
- Relevance and reranking reporting. Shipped in V1.2.
- Stale-context and freshness reporting. Shipped in V1.2.
- Conflicting-context reporting. Shipped in V1.2.
- Extractive-compression reporting. Shipped in V1.2.
- Optimizer configuration controls and copyable request payloads. Shipped in V1.2.
- Request-detail integration.
- Dashboard cards for saved tokens, dropped chunks, reduction, and risk flags.

## V1.2: Quality Loop

Prove that smaller context still answers correctly.

Capabilities:
- Before/after judge scoring. Shipped in V1.2 as raw-context vs optimized-context answer comparison.
- Eval dataset support for raw context vs optimized context.
- Quality delta reports. Shipped in V1.2 for recent events and aggregates.
- Regression alerts when optimization reduces answer quality. V1.2 records regression flags; alert wiring remains future work.

## V2: Persistent Knowledge Distillation

Move from per-request optimization to reusable canonical knowledge.

Capabilities:
- Batch document ingestion.
- Canonical knowledge blocks.
- Source references and provenance.
- Versioning and diffs.
- JSONL/vector-ready export.

## V2.1: Governance

Make optimized knowledge trustworthy for regulated teams.

Capabilities:
- Human review queue.
- Approval states.
- Audit logs.
- Conflict detection.
- PII and prompt-injection policy checks.
- Approved-only export controls.

## V2.2: Connectors

Automatically ingest enterprise knowledge.

Candidate connectors:
- GitHub repositories.
- Confluence.
- Google Drive.
- SharePoint.
- Notion.
- Zendesk or Intercom help centers.
- S3 and local file upload.

## V3: Retrieval Quality Layer

Measure and improve RAG retrieval quality.

Capabilities:
- Retrieval trace ingestion.
- Retrieval precision and unused-context metrics.
- Duplicate, stale, and conflicting context rates.
- Recommendations for source cleanup.
- A/B tests for retrieval settings, rerankers, embedding models, and optimized vs raw context.

## V3.1: Managed Vector Export

Push optimized knowledge into customer-owned retrieval systems.

Targets:
- Pinecone.
- Weaviate.
- Qdrant.
- Chroma.
- pgvector.
- OpenSearch.

## V4: Context Policy Engine

Enforce context rules per application.

Policy examples:
- Max context tokens.
- Approved sources only.
- Freshness limits.
- Permission-aware source filters.
- Prompt-injection quarantine.
- PII redaction.
- Block unreviewed knowledge.

## Algorithm Ladder

The roadmap should advance through these algorithmic layers:

1. Semantic chunking.
2. Embedding similarity and approximate search.
3. Exact, fuzzy, and semantic deduplication.
4. Clustering and canonicalization.
5. Relevance scoring and reranking.
6. Extractive and abstractive compression.
7. Contradiction and conflict detection.
8. Guardrail risk classification.
9. Before/after quality evaluation.
10. Active learning from feedback.
11. Policy-aware context selection.

## Packaging

- Free: basic context token estimation and manual scan.
- Pro: runtime optimization, exact/near dedupe, token savings, firewall scan.
- Team: batch jobs, quality evaluation, retrieval analytics, basic connectors.
- Enterprise: governance workflows, permission-aware connectors, vector export, audit reports, private deployment.
