# Context Optimizer

Context Optimizer is Provara's runtime visibility and optimization layer for retrieved context in RAG and agentic systems. It reduces duplicate context before provider routing and records the savings so teams can inspect what changed.

## Current Scope

The shipped V1 implementation is intentionally narrow:

- Exact duplicate detection after whitespace normalization and case folding.
- Source ID preservation when duplicate chunks are dropped.
- Estimated token savings based on input and output context size.
- Optional risk scanning with active Guardrails rules for retrieved context.
- Flagged and quarantined context buckets with rule evidence and source IDs.
- Tenant-scoped optimization events for reporting.
- Dashboard visibility at `/dashboard/context`.

It does not yet perform semantic deduplication, reranking, abstractive compression, or persistent review workflows. Those belong to later roadmap phases.

## API

Runtime optimization is available through:

```text
POST /v1/context/optimize
```

The request accepts already-retrieved context chunks:

```json
{
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
- `optimization.dropped`: duplicate chunks removed from model context.
- `optimization.flagged`: risky chunks removed from model context but marked for operator review.
- `optimization.quarantined`: risky chunks removed from model context before provider routing.
- `optimization.metrics`: input/output chunk counts, estimated tokens, saved tokens, and reduction percentage.
- `event`: the persisted visibility record for the optimization call.

`scanRisk` defaults to `false` for backwards compatibility. When enabled, Provara uses active Guardrails rules against the `retrieved_context` surface after duplicate removal. `flag` and `redact` actions become flagged context; `block` actions become quarantined context.

Visibility APIs:

```text
GET /v1/context/summary
GET /v1/context/events
```

These endpoints are tenant-scoped and require Intelligence access.

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
- Risk scan result, including flagged and quarantined counts.
- Saved tokens and reduction percentage.
- Duplicate source IDs that were removed.
- Risky source IDs that were flagged or quarantined.

## Demo Mode

The public demo tenant (`t_demo`) seeds recent Context Optimizer events. This keeps `/dashboard/context` useful for demos, screenshots, and product walkthroughs without requiring a live RAG integration.

## Next Roadmap Step

The next behavior layer is the quality loop:

- Compare optimized context against raw context with judge scoring.
- Alert when optimization appears to reduce answer quality.
- Feed risky-context evidence into future review workflows.
