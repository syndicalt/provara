# Provara

Intelligent multi-provider LLM gateway that automatically routes queries to the optimal AI model based on task type and complexity. Compare costs, latency, and quality across providers with built-in A/B testing.

## Features

- **Intelligent Routing** — Automatically classifies queries by task type (coding, creative, summarization, Q&A, general) and complexity (simple, medium, complex), then routes to the optimal model via a configurable task×complexity matrix
- **7 Providers** — OpenAI, Anthropic, Google, Mistral, xAI, Z.ai, and Ollama out of the box
- **A/B Testing** — Create weighted split tests scoped to specific routing cells to compare models head-to-head
- **Cost Analytics** — Track spend per provider, per model, and per routing cell with detailed request logs
- **OpenAI-Compatible API** — Drop-in replacement for any tool or SDK that speaks the OpenAI chat completions format
- **Encrypted Key Storage** — Manage provider API keys through the dashboard with AES-256-GCM encryption at rest
- **Web Dashboard** — Real-time analytics, routing visualization, A/B test management, and API key CRUD

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env — add your PROVARA_MASTER_KEY and any provider API keys

# Generate and run database migrations
npm run db:generate -w packages/db
npm run db:migrate -w packages/db

# Start everything
npx turbo dev
```

- **Gateway**: http://localhost:4000
- **Dashboard**: http://localhost:3001

## Architecture

Turborepo monorepo with three packages:

```
provara/
├── packages/
│   ├── gateway/     # Hono-based LLM proxy (port 4000)
│   │   ├── src/
│   │   │   ├── classifier/   # Task type + complexity heuristics, LLM fallback
│   │   │   ├── routing/      # Task×complexity routing matrix
│   │   │   ├── providers/    # Provider adapters (OpenAI, Anthropic, Google, etc.)
│   │   │   ├── routes/       # API endpoints (analytics, A/B tests, API keys)
│   │   │   ├── crypto/       # AES-256-GCM encryption for API keys
│   │   │   ├── cost/         # Token pricing and cost calculation
│   │   │   └── ab/           # Weighted variant selection
│   │   └── ...
│   └── db/          # Drizzle ORM + SQLite
│       ├── src/
│       │   └── schema.ts     # requests, ab_tests, ab_test_variants, api_keys, cost_logs
│       └── drizzle/          # Migration files
└── apps/
    └── web/         # Next.js + Tailwind dashboard (port 3001)
        └── src/app/
            ├── dashboard/          # Overview, request log, cost analytics
            ├── dashboard/routing/  # Routing matrix and distribution
            ├── dashboard/ab-tests/ # A/B test management and results
            └── dashboard/api-keys/ # Encrypted API key CRUD
```

## How Routing Works

```
Request arrives at POST /v1/chat/completions
  │
  ├─ User specified provider/model? → Use it directly (bypass routing)
  │
  ├─ Classify task type (heuristics: code blocks, keywords, system prompt)
  │   → coding | creative | summarization | qa | general
  │
  ├─ Classify complexity (heuristics: token count, conversation depth)
  │   → simple | medium | complex
  │
  ├─ Either classifier ambiguous? → LLM fallback (cheapest model classifies)
  │
  ├─ Active A/B test on this cell? → Weighted random variant selection
  │
  └─ Look up routing table[taskType][complexity] → provider + model
      └─ Primary unavailable? → Try fallbacks in order
```

### Routing Table

The default routing table optimizes for cost at the simple tier and quality at the complex tier. For example:

| | Simple | Medium | Complex |
|---|---|---|---|
| **Coding** | gpt-4.1-nano | claude-sonnet-4-6 | claude-opus-4-6 |
| **Creative** | gpt-4.1-mini | claude-sonnet-4-6 | claude-opus-4-6 |
| **Q&A** | gemini-2.0-flash | gpt-4.1-mini | gpt-4.1 |

The full table is in [`packages/gateway/src/routing/routing-table.ts`](packages/gateway/src/routing/routing-table.ts).

## API

### Chat Completions (OpenAI-compatible)

```bash
# Let the router pick the best model
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "",
    "messages": [{"role": "user", "content": "Write a Python quicksort"}]
  }'

# Override with a specific model
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Provide a routing hint
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "",
    "routing_hint": "coding",
    "messages": [{"role": "user", "content": "Optimize this query"}]
  }'
```

The response includes routing metadata in `_provara`:

```json
{
  "_provara": {
    "provider": "anthropic",
    "latencyMs": 1234,
    "routing": {
      "taskType": "coding",
      "complexity": "medium",
      "routedBy": "classification",
      "usedFallback": false,
      "usedLlmFallback": false
    }
  }
}
```

### Other Endpoints

| Endpoint | Description |
|---|---|
| `GET /v1/providers` | List active providers and models |
| `POST /v1/providers/reload` | Hot-reload providers after key changes |
| `GET /v1/ab-tests` | List A/B tests |
| `POST /v1/ab-tests` | Create A/B test |
| `GET /v1/ab-tests/:id` | Test detail with results |
| `PATCH /v1/ab-tests/:id` | Update test status |
| `GET /v1/api-keys` | List stored keys (masked) |
| `POST /v1/api-keys` | Add/update an API key |
| `DELETE /v1/api-keys/:id` | Delete an API key |
| `GET /v1/analytics/overview` | Summary stats |
| `GET /v1/analytics/costs/by-model` | Cost breakdown by model |
| `GET /v1/analytics/routing/stats` | Routing traffic stats |
| `GET /v1/analytics/requests` | Paginated request log |
| `GET /health` | Health check |

## Providers

| Provider | Models | API Style |
|---|---|---|
| **OpenAI** | gpt-4o, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, o3, o4-mini | Native SDK |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | Native SDK |
| **Google** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash | Native SDK |
| **Mistral** | mistral-large, mistral-medium, mistral-small | OpenAI-compatible |
| **xAI** | grok-3, grok-3-mini | OpenAI-compatible |
| **Z.ai** | glm-5.1, glm-5-turbo, glm-5v-turbo, glm-4.7, glm-4.7-flash | OpenAI-compatible |
| **Ollama** | Any local model | OpenAI-compatible |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PROVARA_MASTER_KEY` | For key storage | 256-bit hex key for encrypting API keys in the database |
| `OPENAI_API_KEY` | No | Falls back if no DB key set |
| `ANTHROPIC_API_KEY` | No | Falls back if no DB key set |
| `GOOGLE_API_KEY` | No | Falls back if no DB key set |
| `MISTRAL_API_KEY` | No | Falls back if no DB key set |
| `XAI_API_KEY` | No | Falls back if no DB key set |
| `ZAI_API_KEY` | No | Falls back if no DB key set |
| `OLLAMA_BASE_URL` | No | Default: `http://localhost:11434/v1` |
| `PORT` | No | Gateway port (default: 4000) |
| `DATABASE_URL` | No | SQLite path (default: `packages/db/provara.db`) |

## License

MIT
