# Operator runbook: adding a new LLM provider

Two paths depending on how much the new provider looks like OpenAI:

- **OpenAI-compatible provider** (e.g. Fireworks, Together, Groq, DeepSeek, Z.ai) — no code change needed. Add keys via the dashboard, optionally set `baseURL` env, done.
- **Native-API provider** (e.g. new Anthropic-shape endpoint, new streaming protocol) — requires a new adapter under `packages/gateway/src/providers/`. Estimate: 1–2 hours.

## Path A — OpenAI-compatible

1. **Add the API key** via `/dashboard/api-keys` on the affected tenant. Name it after the provider (e.g. `FIREWORKS_API_KEY`). The key is AES-256-GCM encrypted at rest with `PROVARA_MASTER_KEY`.

2. **Set the base URL** via env if it's not `api.openai.com`. Example for Fireworks:

   ```sh
   # Railway env var on provara-gateway
   FIREWORKS_BASE_URL=https://api.fireworks.ai/inference/v1
   ```

3. **Register the provider** by name. If it's not already in `packages/gateway/src/providers/index.ts` autoregister list, add an entry:

   ```ts
   registerOpenAICompatible({
     name: "fireworks",
     apiKeyEnv: "FIREWORKS_API_KEY",
     baseUrlEnv: "FIREWORKS_BASE_URL",
     defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
   });
   ```

4. **Add pricing** in `packages/gateway/src/cost/pricing.ts` (`MODEL_PRICING` record). Use per-1M-token `[input, output]` in USD. Missing entries default to `$0` cost which will break analytics rollups — don't skip this.

5. **Deploy.** The provider's models are discovered at startup via the registry's `refreshModels` hook.

6. **Verify.** Send a completion pinned to the new provider:

   ```sh
   curl -X POST https://gateway.provara.xyz/v1/chat/completions \
     -H "Authorization: Bearer <your-token>" \
     -H "Content-Type: application/json" \
     -d '{"model":"accounts/fireworks/models/llama-v3p3-70b","messages":[{"role":"user","content":"hi"}]}'
   ```

## Path B — Native-API provider

Use `packages/gateway/src/providers/anthropic.ts` as the cleanest template; it's a native adapter that also handles streaming + token counting.

1. **Create `packages/gateway/src/providers/<provider>.ts`** implementing the `Provider` interface from `./types.ts` (`complete`, `completeStream`, optional `discoverModels`).
2. **Handle streaming** — this is the trickiest part. Watch for first-chunk-fallback (empty chunks from the upstream API shouldn't be forwarded as SSE). The adapter must synthesize the `_provara` meta event at the end so the gateway knows the stream finished cleanly.
3. **Add to the registry** in `packages/gateway/src/providers/index.ts` under the same `register(...)` pattern other native adapters use.
4. **Pricing** in `cost/pricing.ts` as with Path A.
5. **Tests** under `packages/gateway/tests/providers/<provider>.test.ts` — at minimum, assert the adapter handles `200 OK`, `4xx error`, and stream-aborted cases.
6. **Deploy and verify** as Path A step 6.

## Common gotchas

- **Dashboard shows the provider but routing never picks it.** Adaptive router requires `MIN_SAMPLES` (default 5) of feedback before a cell routes to a model. Force traffic via a pinned `model` / `provider` for a few completions + judge sample to bootstrap. Set `PROVARA_MIN_SAMPLES=2` temporarily for faster cold-start.
- **Tokens reported wrong.** The OpenAI-compatible adapter trusts the `usage` block in the upstream response. If a provider returns `null` for `input_tokens`, Provara falls back to counting characters / 4 — which is approximate. Patch the provider-specific adapter to do better counting if accurate cost attribution matters.
- **Streaming cuts off early.** Often a keepalive timeout at Railway's edge. Either shorten `PROVARA_STREAM_TIMEOUT_MS` so client-side retry kicks in earlier, or disable streaming for that provider until it's debugged.
