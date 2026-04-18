# Provara

Multi-provider LLM gateway for cost optimization and A/B testing.

## Architecture

Turborepo monorepo with npm workspaces:

- `packages/gateway` — Hono-based proxy exposing an OpenAI-compatible API on port 4000. Provider adapters auto-register based on env vars. Also owns OAuth, teams, billing, email, adaptive routing, and all admin routes.
- `packages/db` — Drizzle ORM + libSQL/SQLite. Schema covers requests, A/B tests, cost logs, model scores, auth (users/sessions/oauth_accounts), team invites, subscriptions, usage reports, and more — migrations live under `packages/db/drizzle/`.
- `apps/web` — Next.js + Tailwind CSS dashboard: monitoring, playground, routing config, admin (tokens, API keys, billing, team, prompts, alerts, guardrails).

## Commands

```bash
npx turbo dev          # Start gateway + web concurrently
npm run dev -w packages/gateway   # Gateway only (port 4000)
npm run dev -w apps/web           # Web UI only (port 3000)

# Database
npm run db:generate -w packages/db   # Generate Drizzle migrations
npm run db:migrate -w packages/db    # Run migrations
npm run db:studio -w packages/db     # Open Drizzle Studio
```

## Providers

OpenAI, Anthropic, Google, Mistral, xAI, Z.ai, Ollama. Each adapter lives in `packages/gateway/src/providers/`. Providers are enabled by setting the corresponding env var or adding keys via the dashboard (`/dashboard/api-keys`):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `MISTRAL_API_KEY`
- `XAI_API_KEY`
- `ZAI_API_KEY`
- `OLLAMA_BASE_URL` (defaults to `http://localhost:11434/v1`)

Ollama is always registered. DB-stored keys (encrypted with `PROVARA_MASTER_KEY`) take precedence over env vars.

## Key Design Decisions

- Gateway exposes an OpenAI-compatible `/v1/chat/completions` endpoint so any existing tool/SDK can point at it as a drop-in replacement.
- All requests are logged to SQLite with token counts, latency, and cost.
- A/B tests use weighted random variant selection.
- Mistral, xAI, Z.ai, and Ollama adapters use the OpenAI SDK with a custom `baseURL` since they expose OpenAI-compatible APIs.
