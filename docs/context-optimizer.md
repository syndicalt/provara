# Context Optimizer

Context Optimizer is Provara's runtime visibility and optimization layer for retrieved context in RAG and agentic systems. It reduces duplicate context before provider routing and records the savings so teams can inspect what changed.

## Current Scope

The shipped V1 implementation is intentionally narrow:

- Exact duplicate detection after whitespace normalization and case folding.
- Optional semantic near-duplicate detection with deterministic token similarity.
- Optional lexical relevance scoring and reranking for retained chunks.
- Optional stale-context detection from bounded freshness metadata.
- Optional conflicting-context detection with bounded heuristic claim checks.
- Source ID preservation when duplicate chunks are dropped.
- Estimated token savings based on input and output context size.
- Optional risk scanning with active Guardrails rules for retrieved context.
- Flagged and quarantined context buckets with rule evidence and source IDs.
- Raw-context vs optimized-context quality scoring with the configured judge model.
- Retrieval analytics for used, unused, duplicate, and risky retrieved chunks.
- Tenant-scoped optimization events for reporting.
- Dashboard visibility at `/dashboard/context`.

It does not yet perform embedding-backed semantic deduplication, abstractive compression, or persistent review workflows. Those belong to later roadmap phases.

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
  "rankMode": "lexical",
  "query": "What is the refund window?",
  "minRelevanceScore": 0.2,
  "freshnessMode": "metadata",
  "maxContextAgeDays": 180,
  "conflictMode": "heuristic",
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

- `optimization.optimized`: chunks retained for model context, optionally reranked and scored for relevance/freshness/conflicts.
- `optimization.dropped`: exact duplicate and near-duplicate chunks removed from model context.
- `optimization.conflicts`: lightweight conflict groups found across retained chunks.
- `optimization.flagged`: risky chunks removed from model context but marked for operator review.
- `optimization.quarantined`: risky chunks removed from model context before provider routing.
- `optimization.metrics`: input/output chunk counts, estimated tokens, saved tokens, reduction percentage, relevance, freshness, and conflict metrics.
- `event`: the persisted visibility record for the optimization call.
- `retrieval`: the persisted retrieval analytics record with efficiency, unused context, duplicate rate, risky context rate, and conflict rate.

`dedupeMode` defaults to `exact` for backwards compatibility. Set `dedupeMode` to `semantic` to also remove near duplicates using deterministic token overlap scoring. `semanticThreshold` defaults to `0.72` and accepts values from `0.5` to `1`.

`rankMode` defaults to `none`. Set `rankMode` to `lexical` and provide `query` to score retained chunks with deterministic token matching and stable reranking. Provara caps query tokens internally, stores aggregate relevance metrics only, and does not persist the query text. `minRelevanceScore` defaults to `0.2` and controls the low-relevance chunk count.

`freshnessMode` defaults to `off`. Set `freshnessMode` to `metadata` to score retained chunks from bounded freshness metadata. Provara checks common fields such as `updatedAt`, `lastModified`, `publishedAt`, and `expiresAt`, stores aggregate freshness metrics only, and does not persist the full metadata payload. `maxContextAgeDays` defaults to `180`.

`conflictMode` defaults to `off`. Set `conflictMode` to `heuristic` to detect lightweight contradictions across retained chunks. The first implementation uses bounded local signals: shared metadata keys, status disagreements, and numeric claim disagreements such as different day/hour/percent/USD values on the same topic. It caps extracted signals and pair comparisons, so this stays deterministic and local; embedding or NLI-backed contradiction checks remain future paid-layer work.

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
- Recent retrieval events with used/retrieved chunks, relevance, freshness, duplicate/semantic/risky counts, and unused source IDs.

## Demo Mode

The public demo tenant (`t_demo`) seeds recent Context Optimizer events. This keeps `/dashboard/context` useful for demos, screenshots, and product walkthroughs without requiring a live RAG integration.

## Next Roadmap Step

The next behavior layer is retrieval quality:

- Stale and conflicting context detection.
- Embedding-backed relevance scoring.
