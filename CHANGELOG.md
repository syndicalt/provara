# Changelog

All notable Provara changes are tracked here.

## 0.2.0 - 2026-05-01

### Added

- Context Optimizer V1 for Intelligence-tier tenants:
  - Runtime exact-duplicate removal through `POST /v1/context/optimize`.
  - Source ID preservation for duplicate chunks.
  - Estimated input/output tokens, saved tokens, dropped chunks, and reduction percentage.
  - Persisted `context_optimization_events` for visibility and reporting.
  - Tenant-scoped visibility APIs: `GET /v1/context/events` and `GET /v1/context/summary`.
  - Dashboard page at `/dashboard/context` with summary cards and recent optimization events.
  - Demo tenant seed data for screenshot-ready Context Optimizer examples.
  - Optional retrieved-context risk scanning with active Guardrails rules, flagged/quarantined result buckets, persisted source IDs, and dashboard risk metrics.
  - Context Optimizer quality loop with `POST /v1/context/evaluate`, persisted `context_quality_events`, demo quality rows, and dashboard quality delta/regression visibility.
  - Context retrieval analytics with persisted `context_retrieval_events`, retrieval efficiency, unused context, duplicate rate, risky context rate, demo rows, APIs, and dashboard visibility.
  - Context Optimizer semantic near-duplicate mode with `dedupeMode: "semantic"`, configurable similarity threshold, separate near-duplicate source IDs/rates, demo rows, APIs, and dashboard visibility.
  - Context Optimizer lexical relevance mode with `rankMode: "lexical"`, query-scored stable reranking, low-relevance/reranked metrics, demo rows, APIs, and dashboard visibility.
  - Context Optimizer embedding relevance mode with `rankMode: "embedding"`, cosine-similarity reranking through the configured embedding provider, and lexical fallback when embeddings are unavailable.
  - Context Optimizer stale-context detection with `freshnessMode: "metadata"`, freshness/stale metrics from bounded metadata parsing, demo rows, APIs, and dashboard visibility.
  - Context Optimizer conflicting-context detection with `conflictMode: "heuristic"`, bounded status/numeric/metadata checks, conflict metrics, demo rows, APIs, and dashboard visibility.
  - Context Optimizer scored contradiction detection with `conflictMode: "scored"`, bounded conflict scores, severity bands, APIs, and dashboard visibility.
  - Context Optimizer extractive compression with `compressionMode: "extractive"`, bounded sentence selection, compression savings metrics, demo rows, APIs, and dashboard visibility.
  - Context Optimizer abstractive compression with `compressionMode: "abstractive"`, provider summaries, provenance preservation, and extractive/original fallback on errors, refusals, or token growth.
  - Managed context collections with tenant-scoped collection APIs, plain-text document ingestion, deterministic block chunking, source provenance, and dashboard visibility.
  - Canonical context blocks with deterministic collection distillation, source coalescing, review statuses, approved-only export, and dashboard counts.
  - Canonical block governance with reviewer notes, reviewed-by metadata, reviewed timestamps, tenant-scoped review audit events, and a dashboard draft review queue.
  - Canonical pre-approval policy checks that run active Guardrails rules before approval, persist policy evidence, block risky approvals, and surface policy status in the dashboard review queue.
  - Bulk canonical policy-check and review actions with per-block results, tenant isolation, audit events, and dashboard row selection.
  - Context governance alerts for policy-check failures, stale canonical review queues, and approved-export delta thresholds in the existing Alerts workflow.
  - Connector ingestion foundation with tenant-scoped manual sources, idempotent source sync into managed documents and blocks, failed-sync status, and dashboard source visibility.
  - GitHub repository connector v1 with bounded tree/blob ingestion, path/extension/file-size filters, SHA-based idempotency, repo/path/SHA provenance, and dashboard source details.
  - Context Optimizer dashboard configuration controls for optimizer modes, thresholds, risk scanning, local draft persistence, and copyable API payloads.
- Prompt Injection Firewall preset for built-in instruction override, system prompt extraction, role takeover, and delimiter-injection signatures.
- Source-aware firewall scan API: `POST /v1/admin/guardrails/scan` supports `user_input`, `retrieved_context`, `tool_output`, and `model_output`.
- Optional semantic and hybrid prompt-injection scan modes using the configured judge model.
- Tool-call alignment guardrail for undeclared tools, invalid tool-call JSON, suspicious argument injection, and data-exfiltration patterns.
- Model refusal fallback for provider responses that end in `content_filter`.
- Persisted `firewall_events` for scan and tool-call alignment activity.
- Tenant firewall settings for default scan mode, tool-call alignment mode, and streaming enforcement.
- Guardrails dashboard sections for Prompt Injection Firewall settings and recent firewall events.
- OpenAPI coverage for firewall scan, settings, and event endpoints.
- Tool-calling support across OpenAI-compatible, Anthropic, and Google adapters.

### Changed

- Context Optimizer roadmap now marks V1 runtime optimization, V1.1 dashboard visibility, risk-aware optimization, V1.2 quality scoring, retrieval analytics, semantic near-duplicate detection, lexical relevance reranking, embedding relevance reranking, stale-context detection, conflicting-context detection, scored contradiction bands, extractive and abstractive compression, dashboard configuration controls, managed context collections, canonical block distillation, canonical review audit trails, canonical policy checks, bulk review actions, context governance alerts, connector ingestion foundation, and GitHub repository connector v1 as shipped checkpoints.
- Guardrails documentation now treats Prompt Injection Firewalling as a first-class guardrails capability.
- The Guardrails dashboard custom-rule creation button now lives beside the Custom Rules table.
- Streaming tool-call responses can buffer tool-call deltas until alignment checks pass.
- Semantic and hybrid firewall scan modes are gated behind Intelligence access on Cloud while deterministic signature scans remain the default path.

### Fixed

- Provider fallback now retries on model refusals instead of only provider errors.
- Tool-capability routing avoids sending tool requests to models that do not support tools.
- Low-score routing diagnostics and challenger probes are easier to surface in the quality workflow.

### Upgrade Notes

- Run database migrations through `0044_firewall_settings`.
- For Context Optimizer visibility, risk reporting, quality scoring, retrieval analytics, semantic near-duplicate metrics, relevance metrics, freshness metrics, conflict metrics, compression metrics, managed collections, canonical blocks, review audit events, canonical policy checks, and connector ingestion foundation, run database migrations through `0058_context_sources`.
- New tables:
  - `firewall_events`
  - `firewall_settings`
  - `context_optimization_events`
  - `context_quality_events`
  - `context_retrieval_events`
  - `context_collections`
  - `context_documents`
  - `context_sources`
  - `context_blocks`
  - `context_canonical_blocks`
  - `context_canonical_review_events`
- Existing tenants keep the safe default firewall settings:
  - `defaultScanMode: "signature"`
  - `toolCallAlignment: "block"`
  - `streamingEnforcement: true`
- The public OpenAPI copy in `apps/web/public/openapi.yaml` is generated from `packages/gateway/openapi.yaml` during web build.
