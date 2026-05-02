# Context Optimizer

Context Optimizer is Provara's runtime visibility and optimization layer for retrieved context in RAG and agentic systems. It reduces duplicate context before provider routing and records the savings so teams can inspect what changed.

## Current Scope

The shipped V1 implementation is intentionally narrow:

- Exact duplicate detection after whitespace normalization and case folding.
- Optional semantic near-duplicate detection with deterministic token similarity.
- Source ID preservation when duplicate chunks are dropped.
- Estimated token savings based on input and output context size.
- Optional risk scanning with active Guardrails rules for retrieved context.
- Flagged and quarantined context buckets with rule evidence and source IDs.
- Raw-context vs optimized-context quality scoring with the configured judge model.
- Retrieval analytics for used, unused, duplicate, and risky retrieved chunks.
- Tenant-scoped optimization events for reporting.
- Dashboard visibility at `/dashboard/context`.

It does not yet perform embedding-backed semantic deduplication, reranking, abstractive compression, or persistent review workflows. Those belong to later roadmap phases.

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
  "scanRisk": true,
  "chunks": [
    {
      "id": "doc-1:chunk-4",
      "content": "Refunds are available within 30 days.",
      "source": "help-center",
      "metadata": { "url": "https://example.com/refunds" }
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

- `optimization.optimized`: chunks retained for model context.
- `optimization.dropped`: exact duplicate and near-duplicate chunks removed from model context.
- `optimization.flagged`: risky chunks removed from model context but marked for operator review.
- `optimization.quarantined`: risky chunks removed from model context before provider routing.
- `optimization.metrics`: input/output chunk counts, estimated tokens, saved tokens, and reduction percentage.
- `event`: the persisted visibility record for the optimization call.
- `retrieval`: the persisted retrieval analytics record with efficiency, unused context, duplicate rate, and risky context rate.

`dedupeMode` defaults to `exact` for backwards compatibility. Set `dedupeMode` to `semantic` to also remove near duplicates using deterministic token overlap scoring. `semanticThreshold` defaults to `0.72` and accepts values from `0.5` to `1`.

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
- Risky context rate.
- Recent retrieval events with used/retrieved chunks, duplicate/semantic/risky counts, and unused source IDs.

## Demo Mode

The public demo tenant (`t_demo`) seeds recent Context Optimizer events. This keeps `/dashboard/context` useful for demos, screenshots, and product walkthroughs without requiring a live RAG integration.

## Next Roadmap Step

The next behavior layer is retrieval quality:

- Relevance scoring and reranking.
- Stale and conflicting context detection.
