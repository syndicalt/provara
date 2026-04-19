# Provara

Intelligent multi-provider LLM gateway with adaptive routing, A/B testing, and cost optimization. Self-host it or use the managed SaaS.

![Dashboard](public/dashboard.png)

## Features

- **Intelligent Routing** — Classifies queries by task type (coding, creative, summarization, Q&A, general) and complexity (simple, medium, complex), then routes to the optimal model
- **Adaptive Quality Scoring** — Every user rating and LLM-judge score updates a live quality EMA per routing cell (task × complexity × model), persisted across restarts. Winning models earn more traffic automatically — no retraining step, no manual model selection to keep current as providers ship new versions
- **Silent-Regression Detection** — Periodically replays your best historical prompts against the current model and alerts when quality drops. Catches upstream provider changes that would otherwise degrade your app invisibly
- **Auto Cost Migration** — When a cheaper model reaches parity on a routing cell, the gateway migrates automatically and reports the projected monthly savings. Quality is gated, rollbacks are one click
- **Auto A/B Generation** — When two models are tied on a routing cell, the gateway spawns its own 50/50 experiment and stops it when a decisive winner emerges
- **A/B Testing** — Split traffic between models with weighted variants, scoped to routing cells
- **8+ Providers** — OpenAI, Anthropic, Google, Mistral, xAI, Z.ai, Ollama, plus any OpenAI-compatible provider
- **Dynamic Model Discovery** — Automatically detects available models from each provider's API at startup, with on-demand refresh
- **Request Logs & Replay** — Browsable request history with full prompt/response detail, replay any request against a different model with side-by-side diff comparison
- **Observability Dashboard** — Time-series charts for request volume, cost breakdown by provider, latency percentiles (p50/p95/p99), and model comparison tables
- **Quality & Eval Pipeline** — LLM-as-judge auto-scoring with configurable sample rate, quality trends over time, manual 1-5 feedback from the dashboard, adaptive routing matrix
- **Guardrails** — Built-in PII detection (SSN, credit card, email, phone, IP), content policies, and custom regex rules with redact/flag/block actions
- **Alerting** — Configurable rules for spend, latency, and request count thresholds with webhook notifications and alert history
- **Prompt Management** — Versioned prompt templates with `{{variable}}` interpolation, publish/rollback, and API resolution by name
- **Cost Analytics** — Track spend per provider, model, and tenant with detailed cost breakdowns
- **OpenAI-Compatible API** — Drop-in replacement for any SDK that speaks the OpenAI chat completions format
- **Streaming** — Full SSE streaming support with first-chunk fallback detection
- **Response Caching** — In-memory cache for deterministic requests (temperature=0)
- **Multi-Tenant** — OAuth (Google + GitHub), role-based access (owner/member), tenant-scoped data
- **SAML SSO** — Enterprise-tier identity-provider integration (Okta, Azure AD, Google Workspace) with IdP-metadata autoconfig and email-domain enforcement
- **Team Invites** — Owner-invite flow with seat quotas per tier, atomic email-verified claim on OAuth callback, transactional invite + welcome email via Resend, and wrong-OAuth-account detection with a sign-out-and-retry banner
- **Audit Logs** — Append-only per-tenant record of security- and admin-relevant events (logins, API-key rotations, subscription changes) with tier-based retention (90 d Free/Pro, 365 d Team, 730 d Enterprise), dashboard viewer, CSV export, and SIEM-friendly cursor-paginated API
- **Spend Intelligence** — Team+/Enterprise dashboard covering per-user/per-token attribution, MTD + run-rate forecast, 7-vs-28-day spend anomaly detection, quality-adjusted spend (p25/median/p75 judge scores next to every cost row), routing-weight drift correlation, and quality-comparable savings recommendations
- **Budgets & Alerts** — Monthly or quarterly caps with per-threshold email alerts (50/75/90/100%) and an optional hard-stop that refuses chat completions with HTTP 402 once the cap is hit
- **Per-IP Rate Limiting** — Flat abuse-protection limits on public auth routes (20/min) and a global DoS floor on `/v1/chat/completions` (200 rps), with per-token `rateLimit` as the separate programmatic-API lever
- **Encrypted Key Storage** — AES-256-GCM encryption for provider API keys at rest, with a documented rotation CLI (`npm run key:rotate`) and operator runbook
- **Web Dashboard** — Sidebar navigation with grouped sections: Monitor, Test, Configure, Admin

### Screenshots

| | |
|---|---|
| ![Analytics](public/analytics.png) **Analytics** — Request volume, cost by provider, latency percentiles, model comparison | ![Logs](public/logs.png) **Request Logs** — Searchable request history with prompt, model, routing, tokens, cost |
| ![Quality](public/quality.png) **Quality** — LLM-as-judge scoring, adaptive routing matrix, quality trends | ![Playground](public/playground.png) **Playground** — Interactive chat with model selection or auto-routing |
| ![Guardrails](public/guardrails.png) **Guardrails** — PII detection, content policies, custom regex rules | ![Providers](public/providers.png) **Providers** — Auto-discovered models with Refresh Models button |
| ![API Keys](public/apikeys.png) **API Keys** — Encrypted provider key storage with active provider display | ![A/B Tests](public/abtests.png) **A/B Tests** — Head-to-head model comparison with quality scoring |

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/syndicalt/provara.git
cd provara

# Set up environment
cp .env.example .env
# Edit .env with your API keys and PROVARA_MASTER_KEY

docker compose up -d
```

### Local Development

```bash
npm install

# Set up environment
cp .env.example .env

# Start everything (gateway + web dashboard)
npx turbo dev
```

- **Gateway**: http://localhost:4000
- **Dashboard**: http://localhost:3000

## Architecture

```
provara/
├── packages/
│   ├── gateway/        # Hono-based LLM proxy (port 4000)
│   │   ├── src/
│   │   │   ├── auth/         # API tokens, OAuth, sessions, RBAC
│   │   │   ├── classifier/   # Task type + complexity heuristics
│   │   │   ├── routing/      # Adaptive routing engine
│   │   │   ├── providers/    # Provider adapters
│   │   │   ├── routes/       # API endpoints (tokens, feedback, alerts, prompts, etc.)
│   │   │   ├── crypto/       # AES-256-GCM encryption
│   │   │   ├── cost/         # Token pricing and cost calculation
│   │   │   ├── cache/        # In-memory response cache
│   │   │   ├── guardrails/   # Input/output content filtering
│   │   │   └── ab/           # Weighted variant selection
│   │   └── openapi.yaml      # OpenAPI 3.0 spec (import into Yaak/Postman)
│   └── db/             # Drizzle ORM + libSQL/Turso
└── apps/
    └── web/            # Next.js + Tailwind dashboard
        └── src/app/
            ├── page.tsx              # Landing page
            ├── login/                # OAuth sign-in
            ├── models/               # Public model catalog
            └── dashboard/
                ├── logs/             # Request logs + detail + replay
                ├── analytics/        # Time-series charts, cost, latency
                ├── quality/          # Quality scores, judge config, feedback
                ├── playground/       # Interactive model testing
                ├── ab-tests/         # A/B test management
                ├── routing/          # Routing pipeline visualization
                ├── providers/        # Provider management
                ├── prompts/          # Prompt template versioning
                ├── alerts/           # Alert rules and history
                ├── guardrails/       # Content safety rules
                ├── tokens/           # API token management
                └── api-keys/         # Provider key management
```

## How Routing Works

![Routing Pipeline](public/routing.png)

```
Request arrives at POST /v1/chat/completions
  │
  ├─ User specified provider/model? → Use it directly
  │
  ├─ Classify task type (heuristics + LLM fallback)
  │   → coding | creative | summarization | qa | general
  │
  ├─ Classify complexity
  │   → simple | medium | complex
  │
  ├─ Active A/B test on this cell? → Weighted random variant
  │
  ├─ Adaptive routing has quality data? → Pick highest-scoring model
  │
  └─ Fallback → all providers sorted by cost (cheapest first)
```

Each request logs which routing method was used in `_provara.routing.routedBy`:
- `"explicit"` — user specified provider/model
- `"routing-hint"` — user provided a task type hint
- `"ab-test"` — matched an active A/B test
- `"adaptive"` — live quality-based routing (see [Adaptive Routing](#adaptive-routing))
- `"classification"` — classifier picked the route

## Adaptive Routing

Provara's adaptive router learns from live traffic. Every user rating submitted to `/v1/feedback` and every score produced by the built-in LLM judge flows into a per-cell quality EMA. Over time, the router leans harder on the models that actually perform well on the traffic you're sending — without a retraining step and without you having to manually swap model names when providers ship new versions.

### The feedback loop

Two signal sources land in the same `feedback` table:

- **User ratings** (`source: "user"`) — explicit 1–5 scores submitted via `POST /v1/feedback` or the dashboard's Quality view.
- **LLM-as-judge** (`source: "judge"`) — the gateway automatically samples a configurable fraction of responses (default ~10%, tunable via `/v1/feedback/judge/config`) and asks another model to score relevance, accuracy, and coherence. The average lands as a `feedback` row with `source: "judge"`.

Both sources feed the same learning loop but with different weights — see [Live learning](#live-learning) below.

### Configuring the judge

The judge has four knobs, all persisted in the `app_config` table and settable from the **Quality** dashboard page or the `/v1/feedback/judge/config` endpoint:

| Field | Type | Purpose |
|-------|------|---------|
| `enabled` | boolean | Master switch. When `false`, no judge scoring runs regardless of sample rate. |
| `sampleRate` | number `0.0 – 1.0` | Probability that any completed request gets scored. `0.2` ≈ 20% of responses judged. |
| `provider` | string \| null | Pin the judge to a specific provider (e.g. `"openai"`). `null` = auto. |
| `model` | string \| null | Pin the judge to a specific model (e.g. `"gpt-4.1-nano"`). Must pair with `provider`. `null` = auto. |

**Model resolution order:**

1. If both `provider` and `model` are set AND the model exists in the registry, the judge uses that pair.
2. If the pin is set but the model has left the registry (provider disabled, model deprecated), the judge logs `[judge] pinned model X/Y not in registry; falling back to cheapest` and picks the cheapest available model instead.
3. If no pin is set, the judge uses the cheapest registered model by input+output token cost.

**When to pin:** the "cheapest model" heuristic backfires in two common situations worth knowing about —

- **Grade inflation.** Very cheap models tend to hand out 4s and 5s uniformly, which gives the adaptive router almost no discriminating signal. Pinning to a slightly beefier judge (e.g. `openai/gpt-4.1-nano`) produces more variation in scores and faster adaptive convergence.
- **Rate-limited cheapest provider.** If your current cheapest model happens to be on a provider with tight rate limits, judge calls will fail on every invocation until the limit clears. Pinning sidesteps this entirely by picking a stable model.

**Judge-target threshold:** adaptive routing ignores a `(cell, provider, model)` until it has at least `PROVARA_MIN_SAMPLES` scored samples (default `5`, settable as a gateway env var). Lower it to `2` during bootstrapping; raise it back once the matrix has coverage.

**Observability:** judge failures are intentionally non-fatal for the main request, but they now log to stderr so operators can catch systematic breakage:

- `[judge] parse failed — X/Y returned unparseable response: ...` — the judge model didn't return valid JSON. Usually means the pinned model is too weak to follow the prompt; pin to a stronger one.
- `[judge] X/Y scoring failed: ...` — the judge's LLM call itself errored (rate limit, timeout, auth).

A **routing cell** is the `(taskType, complexity)` tuple the classifier assigns to each request — e.g. `coding/medium` or `creative/simple`. The router tracks a running quality score per `(cell, provider, model)` independently: GPT-4o on `coding/complex` has its own score, separate from GPT-4o on `qa/simple`. This matters because a model that wins on one cell can lose on another, and a blended global score would hide that.

### Live learning

Every feedback event nudges the relevant score by an exponential moving average. User ratings move the EMA harder than judge scores, so:

- A single user rating meaningfully shifts the result.
- Judge scores accumulate into a stable baseline without any one sample swinging the decision.
- A flood of automated judge traffic can't drown out sparser but higher-signal user feedback.

Scores persist to a `model_scores` table on every update, so a Railway redeploy or local restart resumes with the exact running EMA — not a flat re-average of historical feedback. Weeks of signal don't get lost to a restart.

### When adaptive routing kicks in

Adaptive routing is sample-gated. A `(cell, provider, model)` combination needs at least a few feedback events before the router will pick it on quality grounds. Below that threshold, traffic falls through to cost-ranked fallback (cheapest viable provider first) or to an active A/B test if one scopes to the cell.

Routing priority for each request:

1. **Explicit user override** — the caller specified `provider` + `model` in the request body.
2. **Active A/B test on the cell** — weighted random variant selection.
3. **Adaptive** — the cell has enough signal; pick the highest-scoring model under the active routing profile.
4. **Cost fallback** — no adaptive data yet; route to the cheapest provider that can handle the classification.

Adaptive coexists cleanly with A/B tests: while a test is active, the test wins (so you get controlled comparison data); once it completes, the scores it generated continue shaping the adaptive decision for that cell.

### Tuning the trade-off

The adaptive winner isn't chosen on quality alone. Each candidate is scored against three dimensions — quality, cost, latency — weighted by a **routing profile**:

- `cost` — cheapest wins unless quality is catastrophically bad (20/70/10).
- `balanced` (default) — equal weight on quality and cost, a touch on latency (40/40/20).
- `quality` — highest EMA wins unless cost or latency are egregious (70/15/15).

Profiles can be set per API token (via `/v1/admin/tokens`) so a production workload and a throwaway experiment can share the same adaptive scores but route differently.

## Silent-Regression Detection

**The problem.** You're using a hosted model — `gpt-4o-mini`, `claude-haiku`, `gemini-2.5-flash`, any of them. One Tuesday afternoon, the provider pushes a new version under the same name. Maybe they tuned for safety, or shortened context usage, or swapped the tokenizer. Your API calls keep returning 200s. Your users start emailing you that replies feel "off" — vaguer, shorter, occasionally wrong in ways they weren't before. By the time you notice, a week has passed. Nothing in your monitoring caught it, because nothing was broken. Quality just *drifted*.

This isn't theoretical. It's happened at every major provider. Silent updates are normal, and the industry hasn't agreed on versioning conventions that would make them transparent. From the app developer's seat, a hosted model is a moving target — and you usually find out through customer pain.

**The solution.** Every week (configurable), Provara automatically picks a handful of the best prompts you've already served, re-runs them against the current model, and has an independent LLM judge score the new answers. If today's answers grade materially lower than the ones that originally earned 4 or 5 stars, you get an alert on the Quality dashboard with the specific cell, the specific model, and the magnitude of the drop. You know *before* your users do.

### How it works

The gateway maintains a **replay bank** — per tenant, per routing cell, per model, a curated set of up to 25 historical prompts that scored ≥ 4 stars from the LLM judge. A nightly job (`replay-bank-populate`) keeps this bank fresh with the most recent high-quality, diverse examples, using embedding-based deduplication so the bank doesn't fill up with near-copies of the same question.

A separate weekly job (`replay-execute`) does the actual regression check:

1. For each opted-in tenant, pick a cell that has enough banked prompts (default ≥ 2)
2. Sample `k` prompts from the bank (default `k = 5`), preferring ones that haven't been replayed recently
3. For each prompt, send it back through the current winning model for that cell
4. Ask the LLM judge (same judge you've configured for adaptive routing) to score the new response on the same 1–5 scale
5. Compute the mean across replayed prompts and compare to the mean of the bank's baseline scores
6. If the drop is ≥ `0.5` on the 1–5 scale, fire a regression event

An event is one row in `regression_events` with the provider, model, cell, original mean, replay mean, delta, timestamp, and cost. The dashboard surfaces it as a red-bordered card on the Quality page. You can dismiss it (the row moves to resolved history) or investigate further.

Running the job again on the same cell while a detection is still active *updates* the existing event rather than duplicating — so the card always reflects the latest measurement and the first-detected date holds steady.

### Getting started

Silent-regression detection is **off by default** because it costs real API tokens to run (replays + judge calls). Turn it on per tenant:

1. Go to **Quality → Regression Watch → Enable** on the dashboard (or `POST /v1/regression/opt-in {"enabled": true}`)
2. Make sure the **judge is configured** (Quality → Judge config). Silent regression requires the judge, both to populate the bank with judge-scored baselines and to grade the replays. A cheap judge like `openai/gpt-4.1-nano` works fine and costs fractions of a cent per replay
3. Wait for traffic. The bank only captures prompts that have *already* been judge-scored at ≥ 4, so you need a small corpus of live traffic with judge sampling enabled before there's anything to replay
4. Optionally trigger the populate job manually to seed the bank immediately: `POST /v1/admin/scheduler/jobs/replay-bank-populate/run`

Once the bank has at least 2 entries per cell, the `replay-execute` job will start producing meaningful results. You can trigger it on demand the same way.

### What the dashboard shows

On the **Quality** page, the **Regression Watch** card displays:

| Tile | Meaning |
|---|---|
| **Bank size** | Total prompts currently stored across all your cells. Growing over time is healthy. |
| **Weekly budget** | USD spent on replays + judge calls this ISO week, against the cap. Auto-rolls at week boundary. |
| **Live regressions** | Count of active (unresolved) regression events. `0` is the healthy state. |

When a regression fires, you also get an **Active regressions** table with:

- **Cell** — task type + complexity (e.g. `coding+simple`)
- **Model** — the provider/model the regression was detected on
- **Original** — mean score of the bank's baseline samples
- **Replay** — mean judge score on the re-runs
- **Δ** — the drop (negative is bad)
- **Detected** — when it was first observed
- **Dismiss** — resolve the event, moving it to the collapsed history

A resolved history collapsible below the active table preserves the full record for audit.

### Tuning

All thresholds are environment variables, read once at gateway startup:

| Variable | Default | Purpose |
|---|---|---|
| `PROVARA_REPLAY_BANK_MAX` | `25` | Prompts per cell kept in the bank. Higher = more representative but bigger storage. |
| `PROVARA_REPLAY_BANK_MIN_SCORE` | `4` | Minimum judge score for a prompt to enter the bank. Raising to `5` keeps only the cream; lowering risks noise. |
| `PROVARA_REPLAY_SAMPLE_K` | `5` | Prompts replayed per cell per cycle. Balances cost against detection sensitivity. |
| `PROVARA_REPLAY_DIVERSITY` | `0.1` | Minimum cosine distance (1 − similarity) a new prompt must have from existing bank entries. Higher = more forced diversity. |
| `PROVARA_REGRESSION_DELTA` | `-0.5` | Score drop that triggers a regression event. A stricter `-0.3` alerts on smaller drifts; `-0.7` only catches dramatic failures. |
| `PROVARA_REGRESSED_EXPLORATION_RATE` | `0.5` | ε-greedy rate applied to cells with an active regression. Higher = faster discovery of alternatives at the cost of more routing churn. |
| `PROVARA_REPLAY_BUDGET_USD` | `5` | Per-tenant weekly cap on replay + judge spend. The cycle skips cells once the cap is hit. |
| `PROVARA_REPLAY_BANK_INTERVAL_MS` | `86400000` (1 day) | How often the populate job runs. |
| `PROVARA_REPLAY_CYCLE_INTERVAL_MS` | `604800000` (7 days) | How often the replay job runs. Weekly is usually enough; daily is overkill unless you're in high-change territory. |

### Interpreting results

A fresh enable will often show zero regressions for days or weeks, which is correct — most models stay stable most of the time. A regression typically surfaces within hours of a real upstream change.

Things to watch for:

- **One cell, one model** — almost always an upstream provider change. Check the provider's changelog, consider rolling your code to a sibling model (e.g. `gpt-4o-mini` → `gpt-4.1-mini`), or let adaptive routing shift traffic naturally as the bad model's EMA decays.
- **Multiple cells, same model** — stronger signal for an upstream change. Same response.
- **Multiple cells, different models, same delta** — calibration issue, not a real regression. This used to be a known false-positive mode when the bank mixed user ratings with judge scores; the fix (#160) now requires judge-scored baselines for apples-to-apples comparison. If you see this pattern today, file an issue with the event details.
- **Expected delta varies by cell** — smaller cells (less traffic, smaller bank) are noisier. Treat a single-event detection in a low-volume cell with more skepticism than one in a heavy cell.

### The closed loop — detection also fixes the route

Everything above is the *detection* half. Detection without action would be a loud alarm nobody can silence. Provara closes the loop automatically in two ways:

1. **Judge scores from replays feed back into the adaptive router's EMA.** Every score the judge produces during a replay cycle is the same kind of signal adaptive routing already consumes from live traffic. We treat them identically: `adaptive.updateScore(cell, provider, model, score, "judge")`. Net effect — the moment a regression is observable, the regressed model's quality EMA drops on the very next routing decision. You don't have to wait for organic judge sampling to catch up. The router stops preferring the degraded model immediately.

2. **Cells with active regressions get a higher ε-greedy exploration rate.** Dropping the EMA moves the router off the bad model, but it only moves the router to whatever was *second-best* at the time. Maybe something even better has come along since. When a cell has an unresolved regression, the exploration rate rises (default `0.5`, configurable via `PROVARA_REGRESSED_EXPLORATION_RATE`) so the router uniformly samples *alternatives* more aggressively. Each of those samples generates fresh EMA signal, and a new winner emerges on real evidence rather than old snapshot data.

The dismissal action flips both off for that cell — the regression event moves to resolved history, the in-memory regression-cell table refreshes, and the cell returns to the normal exploration rate on the next request.

What you'll observe in practice:

- Before the fix lands: the alert fires, you see it on the dashboard, but the router keeps routing to the regressed model for a day or two until live judge samples catch up
- After the fix: alert fires, next chat completion to that cell sees a different model, dashboard keeps showing the regression so you know why the routing changed, exploration spikes the sample count on alternatives, a new winner stabilizes within hours

The feature is still conservative about hard actions — it does not auto-rollback cost migrations, hard-disable providers, or silently delete the regressed model from your config. Detection produces a signal plus graceful re-routing; destructive actions remain operator decisions.

## Auto Cost Migrations

**The problem.** Your adaptive routing matrix shows which models win on which cells. Over time, cheaper models reach parity on lots of cells — especially as providers ship new budget tiers (think `gpt-4.1-mini`, `claude-haiku-4-5`, `gemini-2.5-flash`). But *migrating* a cell is its own work: you have to notice the parity, trust the cheaper model, actually swap it in, and monitor. Most teams don't. They leave money on the table indefinitely, running `gpt-4o` for tasks `gpt-4o-mini` handles just as well.

**The solution.** Every night, Provara scans your routing matrix and looks for cells where a **cheaper** model is holding quality within tolerance of the current winner. When it finds one, it records a migration and nudges the adaptive router to start actually routing through the cheaper model, with a **grace window** that gives the cheaper model time to prove itself on live traffic. If it performs, you save money automatically. If it doesn't, normal adaptive routing reverts once the grace window ends — you didn't break anything, you just ran a bounded experiment.

The dashboard surfaces the projected monthly savings so the value is visible, not speculative.

### How it works

A nightly job (`cost-migration`) iterates the model-scores table and, for each `(taskType, complexity)` cell, evaluates the non-winning models against the current winner. A model qualifies as a migration candidate when **all** of these hold:

- **At least 20% cheaper** — `candidate.costPer1M < winner.costPer1M * 0.8` (configurable)
- **Quality within tolerance** — `winner.qualityScore − candidate.qualityScore ≤ 0.2` on the 1–5 scale (configurable)
- **Enough samples** — `candidate.sampleCount ≥ 2 × MIN_SAMPLES` (stricter than adaptive routing, because a migration is meant to be semi-permanent)
- **Fresh signal** — `candidate.updatedAt` within the last 30 days (no stale cells)

If multiple candidates qualify for one cell, the **cheapest** wins. Each executed migration records a `cost_migrations` row with the before/after cost, quality scores, projected savings, grace window, and (if rolled back later) a rollback timestamp + reason.

The executed migration does **not** mutate the underlying EMA. Instead, the adaptive router consults an in-memory "grace boost" table on every routing decision — migration targets get a small quality-score bonus (default `+0.3`) for the duration of the grace window (default 30 days). This is enough to flip the router's decision toward the cheaper model during the window, but lets normal EMA signal reassert if the migration turns out to be wrong. Once the window closes, the boost drops to zero and the router decides purely on live evidence.

**Projected savings math:** the job takes the cell's last-30-day traffic volume, multiplies by the average input+output tokens per request, and prices the delta between `from.costPer1M` and `to.costPer1M`. If traffic is zero, projected savings is reported as `$0` (the migration still fires — the router preference shifts — but the savings claim stays honest).

### Safety rails

Because migrations affect live routing, the feature ships with multiple guardrails:

- **Off by default** — opt-in per tenant via the dashboard or API
- **Cap per cycle** — at most 3 migrations per nightly run (no mass reshuffle)
- **Cooldown per cell** — once a cell is migrated, it can't be migrated again for 30 days, regardless of what the scores say
- **Grace window instead of hard switch** — if the cheaper model misbehaves, it loses grace on day 31 and the router reverts based on real signal
- **Manual rollback** — one-click on the dashboard, or `POST /v1/cost-migrations/:id/rollback`. Clears the grace boost immediately and stamps an audit reason
- **Works with regression detection** — if silent-regression detection fires on a migration target during the grace window, that's strong signal the migration was wrong; operators can dismiss the event or roll back

### Getting started

1. Opt in: **Routing → Cost Migrations → Enable** (or `POST /v1/cost-migrations/opt-in {"enabled": true}`)
2. Let adaptive routing accumulate scores for a few days first. The migration evaluator requires `2 × MIN_SAMPLES` (default 10) data points per candidate model per cell, so a fresh install won't qualify anything immediately
3. The nightly job runs automatically. To see results faster, trigger on demand: `POST /v1/admin/scheduler/jobs/cost-migration/run`
4. Check the **Routing → Cost Migrations** card for executed migrations and projected savings

### What the dashboard shows

On the **Routing** page, the **Cost Migrations** card displays:

| Tile | Meaning |
|---|---|
| **Projected savings this month** | Sum of projected monthly savings across all active (not rolled-back) migrations executed in the current month |
| **Active migrations** | Count of non-rolled-back migrations with their grace window still running |
| **Rolled back** | Count of migrations operators reverted (kept for audit) |

The **Active migrations** table shows, per row: the cell, the old model (with its quality score and $/1M), the new model (same), projected monthly savings, grace-end date, and a rollback button.

Rolled-back history lives in a collapsed `<details>` below the active table.

### Tuning

| Variable | Default | Purpose |
|---|---|---|
| `PROVARA_COST_MIGRATION_EPSILON` | `0.2` | Maximum quality gap (1–5 scale) between winner and candidate. Lower = stricter parity requirement. |
| `PROVARA_COST_MIGRATION_RATIO` | `0.8` | Candidate's cost-per-1M must be below `winner.costPer1M × ratio`. `0.8` = at least 20% cheaper. `0.5` = only migrate when cheaper by half. |
| `PROVARA_COST_MIGRATION_MIN_SAMPLES` | `2 × MIN_SAMPLES` | Sample floor for migration eligibility — stricter than adaptive routing because a migration is meant to be lasting. |
| `PROVARA_COST_MIGRATION_GRACE_BOOST` | `0.3` | Quality-score bonus applied to the migration target during grace. Higher = more decisive shift. |
| `PROVARA_COST_MIGRATION_GRACE_DAYS` | `30` | Length of grace window. Shorter = faster natural revert if migration was wrong; longer = more time to accumulate real signal. |
| `PROVARA_COST_MIGRATION_COOLDOWN_DAYS` | `30` | Per-cell cooldown after any migration. Prevents thrash. |
| `PROVARA_COST_MIGRATION_MAX_PER_CYCLE` | `3` | Upper bound on migrations per nightly run. Raise carefully. |
| `PROVARA_COST_MIGRATION_INTERVAL_MS` | `86400000` (1 day) | Scheduler cadence. |

### Interpreting results

Healthy output: one or two migrations in the first week after opt-in (catching the low-hanging `gpt-4o → gpt-4o-mini` type swaps), then gradually fewer as the matrix optimizes. After a while, migrations should fire only when providers ship new budget tiers.

Watch for:

- **Zero migrations ever** — either your traffic is too low to hit the sample floor, or your matrix is genuinely already optimal, or your `EPSILON` is too strict. Check `/v1/analytics/adaptive/scores` to see sample counts per cell.
- **Migrations firing back into the same cell after cooldown** — thrash. The scores for the two models are genuinely close enough that noise flips them. Consider lowering `EPSILON` (require a bigger quality margin before migrating) or raising `MIN_SAMPLES` (require more evidence).
- **A migration's target starts firing regressions** — the cheaper model couldn't hold quality under real traffic. Roll back and let the original winner resume.

## Background Jobs

The three features above — auto A/B generation (routing matrix), silent-regression detection, and auto cost migration — all run on the same lightweight in-process scheduler. There's no external job queue, no Redis, no cron binary. Each job is just a function the gateway calls on an interval, with persistent run-state in `scheduled_jobs` so restarts don't lose the schedule.

Job state is exposed to operators via two owner-only endpoints:

- `GET /v1/admin/scheduler/jobs` — list all registered jobs with their interval, last run, status (`ok` / `error` / `skipped`), last error message (if any), and total run count
- `POST /v1/admin/scheduler/jobs/:name/run` — trigger a job immediately, synchronous to the request

Registered jobs today:

| Name | Interval | Purpose |
|---|---|---|
| `auto-ab` | 24h | Scan for cells where the top two models are tied within `EPSILON_TIE` and spawn 50/50 experiments. Stop existing auto-experiments when a clear winner emerges. |
| `replay-bank-populate` | 24h | Capture high-scoring historical prompts into the per-cell replay bank. |
| `replay-execute` | 7d | Sample the bank, re-run prompts against current models, judge the outputs, emit regression events on drops. |
| `cost-migration` | 24h | Evaluate cells for cheaper-with-parity candidates and execute qualifying migrations with a grace window. |

### Multi-replica deployments

The scheduler is **single-replica by default**. Each gateway instance runs its own timers — so if you deploy two replicas, both would try to run every job. That's fine for idempotent reads but could double-count spend on replay cycles.

To run on exactly one replica, set `PROVARA_SCHEDULER_ROLE=leader` on that replica and omit it (or set it to any other value) on the rest. Non-leader replicas register their jobs in `scheduled_jobs` for observability but never actually start the timers. This is sufficient for Railway, Fly.io, and single-VPS self-hosts. A distributed leader-election protocol (Redis, etcd) is tracked in [#50](https://github.com/syndicalt/provara/issues/50) if and when horizontal scale-out becomes a priority.

### On-demand invocation

Manual runs are useful for:

- **Demoing the feature** without waiting for the next cron tick
- **Incident response** when you want to force a replay cycle after a suspected upstream change
- **Testing** in development where 24h intervals are impractical

Hit `POST /v1/admin/scheduler/jobs/<name>/run` (owner auth required) and the job fires immediately. The running-job guard ensures two overlapping invocations of the same job don't race — the second is recorded as a skipped run.

## How Provara saves tokens

Token cost is a per-token charge from the upstream provider. Wire-level compression (gzip, brotli) doesn't reduce it — tokens are already a compressed representation. The only honest paths to savings are **semantic**: don't bill tokens you've already paid for.

Provara runs two cache layers before any provider call:

1. **Exact-match cache** — in-memory, 5-minute TTL. A byte-for-byte identical prompt hits this in microseconds. No tokens billed. Default-on for deterministic requests (`temperature = 0`).
2. **Semantic cache** — embeddings + cosine similarity. A prompt that's *semantically equivalent* to one you've seen recently — even if the wording differs — returns the cached response. Also zero tokens billed. Default-on when an OpenAI API key is available.

On a hit from either layer, the `requests` row records `cached = true`, `cache_source = "exact" | "semantic"`, and the `tokens_saved_input` / `tokens_saved_output` columns capture what would have been billed. The dashboard and `/v1/analytics/cache/savings` endpoint aggregate these into the advertisable "Tokens Saved" number.

### Semantic cache mechanics

- **Eligibility:** single-turn user requests with an optional system prompt. Multi-turn conversations miss (history-matching semantics are unresolved — better to miss cleanly than guess).
- **Match criteria:** same `(tenant, provider, model)`, same system-prompt hash, cosine similarity ≥ `PROVARA_SEMANTIC_CACHE_THRESHOLD` (default `0.97`).
- **Safety net:** prompts that look personalized ("my ...", "our ...", emails, phone numbers) skip the semantic match. They still hit the exact cache. This is a soft heuristic, not a security boundary.
- **Model:** `text-embedding-3-small` by default (`PROVARA_EMBEDDING_MODEL`). Cached vectors are tagged with their embedding model, so switching models invalidates the semantic cache without returning stale cross-space matches.
- **Storage:** DB-backed (`semantic_cache` table) with an in-memory mirror rehydrated on boot. LRU eviction at 10,000 entries per tenant.
- **Opt-out:** per-request (`{"cache": false}`), per-deployment (`PROVARA_SEMANTIC_CACHE_ENABLED=false`).

### Tuning

| Env var | Default | Purpose |
|---|---|---|
| `PROVARA_SEMANTIC_CACHE_ENABLED` | `true` | Hard off-switch. When `false`, the semantic layer is skipped entirely; exact-match cache is unaffected. |
| `PROVARA_SEMANTIC_CACHE_THRESHOLD` | `0.97` | Cosine similarity required for a match. Raise to err on the side of correctness (fewer hits, zero false positives); lower for aggressive deduplication. |
| `PROVARA_EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model. Must be one of `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`. |
| `PROVARA_EMBEDDING_PROVIDER` | `openai` | Only `openai` is supported in the MVP. Unknown values disable semantic cache. |

## Audit Logs

Every security- and admin-relevant event is written to an append-only per-tenant log. Used for compliance (SOC 2, ISO 27001, internal policy) and for operational "who revoked our API key last Friday?" questions.

### What gets logged

- **Auth** — `auth.login.success` (method: magic_link / google / saml), `auth.login.failed`, `auth.session.revoked`, `auth.sso_config.updated`
- **Users & team** — `user.invited`, `user.joined`, `user.removed`, `user.role_changed`
- **Access surface** — `api_key.created`, `api_key.revoked`, `token.created`, `token.revoked`, `token.rotated`
- **Billing** — `billing.subscription.created/updated/canceled`, `billing.checkout.started`
- **Abuse signals** — `rate_limit.exceeded` (emitted only when the blocked caller has a resolvable tenant; suppressed at 1 audit row per `(scope, ip, tenant)` per minute so bursts don't flood the log)

Each row carries `tenantId`, `actorUserId` (nullable for system events), `actorEmail` (denormalized so "Alice deleted API key X" survives Alice being removed), `resourceType`, `resourceId`, and free-form JSON `metadata`.

### Retention

| Tier | Window |
|---|---|
| Free / Pro | 90 days |
| Team | 365 days |
| Enterprise / Self-host Enterprise | 730 days |

A scheduler job (`audit-retention`) deletes rows past the per-tier cutoff daily, chunked 10k at a time. The app layer is the only UPDATE/DELETE writer on `audit_logs` — no app code path issues UPDATE.

### Access

- **Dashboard** — `/dashboard/audit` (Team+). Filter by actor email / action / date range, paginated cursor, one-click CSV export.
- **SIEM pull** — `GET /v1/audit-logs?action=...&actor=...&since=...&until=...&cursor=...&format=json|csv&limit=...`. Cursor-paginated, 500-row page ceiling. Tenant-scoped; operators can view cross-tenant via the admin UI.

### Emission pattern

Audit writes are **fire-and-forget**: an audit-write failure must never block the underlying action. Calls use `emitAudit(db, event)`, which wraps a `.catch()` around the insert and logs write failures to stdout. Tests needing to observe the row use `emitAuditSync`.

## Spend Intelligence (Team+ / Enterprise)

A dedicated `/dashboard/spend` surface that goes beyond plain cost attribution. Answers Finance/FinOps questions Provara's router is uniquely positioned to answer:

1. **Who spent it?** — per-user + per-token attribution (Enterprise)
2. **On what?** — per-provider / per-model / per-category (Team+)
3. **Is the quality worth it?** — every spend row carries the judge-score envelope (`quality_median`, `quality_p25`, `quality_p75`, `cost_per_quality_point`)
4. **Where is it trending?** — MTD total, linear-run-rate projection, 7-vs-28-day anomaly flag
5. **Did my last routing change save money?** — weight-snapshot diff events joined with the per-provider spend mix in the 14-day attribution window after each change (Enterprise)
6. **Where's my biggest savings opportunity?** — ranked recommendations from same-quality cheaper alternates using the adaptive router's `model_scores.qualityScore` (Enterprise)
7. **Stay within budget** — monthly/quarterly caps with threshold emails and an optional hard-stop

### API endpoints (tenant-scoped, under `/v1/spend/*`)

| Path | Tier | What it returns |
|---|---|---|
| `GET /by?dim=provider\|model\|user\|token\|category&from=&to=&compare=prior\|yoy` | Team+ (user/token → Enterprise) | Spend rows with the full quality envelope and period-over-period delta |
| `GET /trajectory?period=month\|quarter` | Team+ | MTD, projected, prior-period total, anomaly flag with reason |
| `GET /drift?from=&to=&window=<days>` | Enterprise | Weight-change events with per-provider spend-mix in the attribution window after each (default 14 d, max 90) |
| `GET /recommendations` | Enterprise | Ranked from → to swaps with estimated monthly savings and confidence samples |
| `GET /budgets`, `PUT /budgets` | Team+ | Budget CRUD (period, cap, alert thresholds, alert emails, hard_stop flag) |
| `GET /export?dim=&from=&to=&format=csv` | Same as `/by` per dim | CSV export with `currency=USD` column, filename encodes tenant + dim + dates |

### Budget hard-stop

When `hard_stop=true` is set on a budget and current-period spend has hit the cap, every `/v1/chat/completions` call returns:

```json
{ "error": { "message": "Spend budget exceeded: 250.00 / 250.00 USD (monthly).", "type": "budget_exceeded" } }
```

with HTTP 402. The soft path (email-only) fires as thresholds are crossed regardless of the `hard_stop` setting.

### Data model

- **Attribution** — `requests.user_id` and `requests.api_token_id` (nullable, populated at ingest from the auth context); denormalized onto `cost_logs` so per-user / per-token aggregations hit a covering index without a join.
- **Weight snapshots** — `routing_weight_snapshots(tenant_id, task_type, complexity, weights, captured_at)`, one row per tenant per day, only written when weights differ from the prior snapshot.
- **Budgets** — `spend_budgets(tenant_id PK, period, cap_usd, alert_thresholds JSON, alert_emails JSON, hard_stop, alerted_thresholds JSON, period_started_at, ...)`.

## Rate Limiting

Two independent layers, by design:

| Layer | Scope | Default | Purpose |
|---|---|---|---|
| Per-IP on `/auth/*` | IP | 20 / min | Credential stuffing + invite-token brute force |
| Per-IP on `/v1/chat/completions` | IP | 200 rps | Global DoS floor |
| Per-token on `/v1/chat/completions` | API token | `apiTokens.rateLimit` (nullable) | Programmatic budget lever, tenant-configurable per token |

Exhaustion returns `HTTP 429` with `Retry-After` (seconds) and `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers. Blocked calls from **authenticated** callers emit a `rate_limit.exceeded` audit event (suppressed at 1 / minute / tenant / endpoint so sustained bursts don't flood audit_logs); unauthenticated blocks log to stdout only.

Pricing-tier quotas (Free 10k / Pro 100k / Team 500k / Ent custom requests per month) are a separate layer enforced by `requireQuota` + `usage-metering` — rate limit is per-second, quota is per-month.

### Tuning

| Env var | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_AUTH_PER_MIN` | `20` | Per-IP cap on `/auth/*` |
| `RATE_LIMIT_CHAT_RPS` | `200` | Per-IP global DoS floor on `/v1/chat/completions` |
| `RATE_LIMIT_INVITE_PER_MIN` | `20` | Per-IP cap on invite endpoints |

## Invite-Mismatch Detection

When a user clicks an invite link and then signs in with an OAuth account whose email doesn't match the invited email, the flow previously looked successful from Google/GitHub's side — but the invite stayed pending and the user landed in a fresh solo workspace.

Now: the invite token is threaded from `/invite/[token]` → `/login` → gateway OAuth start (stored in a short-TTL `provara_oauth_invite` cookie alongside state/return). Both OAuth callbacks compare the invited email against the profile email case-insensitively. On mismatch, the user still gets signed up (their own workspace) but is redirected to `/dashboard?invite_status=wrong_email&expected=<email>` where a non-dismissible banner offers a one-click sign-out and retry. Already-consumed invites are treated as no-mismatch.

## Master-Key Rotation

`PROVARA_MASTER_KEY` encrypts one thing: the provider API keys stored via `/dashboard/api-keys` (table: `api_keys`, AES-256-GCM). Env-var-driven providers never touch it. A documented rotation CLI + runbook live under `docs/runbooks/master-key-rotation.md` — the short version:

```sh
# 1. Generate a new 32-byte hex key (store in your secrets manager)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Dry-run against prod (verifies every row decrypts with the old key)
DATABASE_URL=... DATABASE_AUTH_TOKEN=... \
  npm run key:rotate -w packages/gateway -- \
    --old "$CURRENT_KEY" --new "$NEW_KEY" --dry-run

# 3. Real rotation (same command, no --dry-run)
# 4. Update PROVARA_MASTER_KEY env var on Railway and redeploy
# 5. Verify a stored provider key still decrypts on the dashboard
```

The CLI uses a two-phase-with-decrypt-gate pattern: phase 1 decrypts every row with the old key into memory (aborts if any row fails), phase 2 re-encrypts with the new key row-by-row. See the runbook for failure-mode recovery.

## A/B Testing Guide

![A/B Tests](public/abtests.png)

A/B tests let you compare two or more models head-to-head on real traffic. Here's a full walkthrough:

### 1. Create a test

```bash
curl -X POST http://localhost:4000/v1/ab-tests \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GPT-4o vs Claude Sonnet for coding",
    "description": "Compare quality and latency on coding tasks",
    "taskType": "coding",
    "complexity": "medium",
    "variants": [
      { "provider": "openai", "model": "gpt-4o", "weight": 1 },
      { "provider": "anthropic", "model": "claude-sonnet-4-6", "weight": 1 }
    ]
  }'
```

- **taskType** and **complexity** scope the test to a routing cell. Only requests classified as `coding/medium` will be split between variants. Omit them to test across all traffic.
- **weight** controls traffic distribution. Equal weights = 50/50 split. Set `"weight": 3` on one variant for 75/25.

### 2. Send traffic

Route requests through Provara without specifying a model — the router will detect the A/B test and split traffic:

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "",
    "messages": [
      {"role": "user", "content": "Write a Python function to merge two sorted arrays"}
    ]
  }'
```

The response includes which variant was used:

```json
{
  "_provara": {
    "provider": "anthropic",
    "latencyMs": 1847,
    "routing": {
      "taskType": "coding",
      "complexity": "medium",
      "routedBy": "ab-test"
    }
  }
}
```

### 3. Check results

```bash
curl http://localhost:4000/v1/ab-tests/YOUR_TEST_ID
```

Returns per-variant stats: request count, avg latency, avg tokens, and total cost. You can also view results in the dashboard at `/dashboard/ab-tests`.

### 4. Submit feedback (optional)

Quality scoring makes A/B tests more useful. Rate responses to build quality data:

```bash
curl -X POST http://localhost:4000/v1/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "THE_REQUEST_ID",
    "score": 4,
    "comment": "Good answer but missed edge case"
  }'
```

Scores also feed the live adaptive router — see [Adaptive Routing](#adaptive-routing) for how the feedback loop works and when it starts influencing traffic.

### 5. Complete the test

```bash
curl -X PATCH http://localhost:4000/v1/ab-tests/YOUR_TEST_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

Or pause it with `"status": "paused"` to stop traffic splitting without losing data.

## Playground

The dashboard ships with an interactive chat UI at **[`/dashboard/playground`](http://localhost:3001/dashboard/playground)** for exercising the gateway end-to-end without touching `curl`.

- **Model selection** — pick a specific `provider/model`, or leave it blank to let the adaptive router choose. The response panel shows which route won (`explicit`, `adaptive`, `ab-test`, `classification`, etc.) and the `X-Provara-Request-Id` header so you can cross-reference the logs view.
- **Inline 5-star rating** — every assistant turn has a rating row. Clicking a star posts to `POST /v1/feedback` with `source: "user"` and the request ID. Scores feed the same EMA used by the adaptive router, so playground ratings train production routing directly — see [Live learning](#live-learning).
- **Comparison / replay** — any request from the playground (or anywhere else) can be opened in `/dashboard/logs/:id` and replayed against a different model with a side-by-side diff.

The playground is the easiest way to bootstrap quality data: 20–30 rated turns per `(taskType, complexity)` cell is usually enough to start biasing traffic measurably.

## API

**Full reference:** an OpenAPI 3 spec lives at [`packages/gateway/openapi.yaml`](packages/gateway/openapi.yaml) and is rendered as an interactive reference at **[`/docs/api`](http://localhost:3001/docs/api)** on the dashboard (powered by [Scalar](https://scalar.com)). When you change the spec, the web app's `predev`/`prebuild` script syncs it to `apps/web/public/openapi.yaml` automatically.

### Chat Completions (OpenAI-compatible)

```bash
# Let the router pick the best model
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "",
    "messages": [{"role": "user", "content": "Write a Python quicksort"}]
  }'

# Force a specific provider/model
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Streaming
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "",
    "stream": true,
    "messages": [{"role": "user", "content": "Tell me a story"}]
  }'
```

### Endpoints

| Endpoint | Description |
|---|---|
| **Chat** | |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions (auth required) |
| **Models** | |
| `GET /v1/providers` | List active providers and models |
| `GET /v1/models/stats` | All models with pricing, latency, and quality stats |
| `GET /v1/models/pricing` | Full pricing table |
| **A/B Tests** | |
| `GET /v1/ab-tests` | List all tests |
| `POST /v1/ab-tests` | Create a test |
| `GET /v1/ab-tests/:id` | Test detail with per-variant results |
| `PATCH /v1/ab-tests/:id` | Update status (active/paused/completed) |
| `DELETE /v1/ab-tests/:id` | Delete a test |
| **Feedback** | |
| `POST /v1/feedback` | Submit quality feedback (score 1-5) |
| `GET /v1/feedback` | List feedback entries |
| `GET /v1/feedback/quality/by-model` | Quality scores by model |
| **Analytics** | |
| `GET /v1/analytics/overview` | Summary stats |
| `GET /v1/analytics/requests` | Paginated request log |
| `GET /v1/analytics/requests/:id` | Single request detail with feedback |
| `GET /v1/analytics/timeseries` | Time-series: volume, cost, latency (p50/p95/p99) |
| `GET /v1/analytics/timeseries/cost-by-provider` | Stacked cost breakdown over time |
| `GET /v1/analytics/models/compare` | Model comparison for a time range |
| `GET /v1/analytics/costs/by-model` | Cost breakdown by model |
| `GET /v1/analytics/routing/stats` | Routing traffic by cell |
| `GET /v1/analytics/adaptive/scores` | Adaptive routing EMA scores |
| `GET /v1/cache/stats` | Cache hit/miss stats |
| **Quality** | |
| `GET /v1/feedback/quality/trend` | Quality score trend over time |
| `GET /v1/feedback/quality/by-model` | Quality scores by model |
| `GET/PUT /v1/feedback/judge/config` | Configure LLM judge: `enabled`, `sampleRate`, `provider`, `model`. Pin `provider`+`model` to bypass cheapest-first selection (see [Configuring the judge](#configuring-the-judge)). |
| **Alerts** | |
| `GET/POST /v1/admin/alerts/rules` | Manage alert rules |
| `PATCH/DELETE /v1/admin/alerts/rules/:id` | Update or delete a rule |
| `GET /v1/admin/alerts/history` | Alert firing history |
| `POST /v1/admin/alerts/evaluate` | Manually evaluate all rules |
| **Prompts** | |
| `GET/POST /v1/admin/prompts` | List or create prompt templates |
| `GET/DELETE /v1/admin/prompts/:id` | Get or delete a template with versions |
| `POST /v1/admin/prompts/:id/versions` | Add a new version |
| `POST /v1/admin/prompts/:id/publish/:versionId` | Publish a specific version |
| `GET /v1/admin/prompts/resolve/:name` | Resolve template by name with variable substitution |
| **Admin** | |
| `GET/POST/DELETE /v1/api-keys` | Manage encrypted provider API keys |
| `GET/POST/PATCH/DELETE /v1/admin/tokens` | Manage API tokens (with enable/disable) |
| `GET/POST/PATCH/DELETE /v1/admin/providers` | Manage custom providers |
| `GET/PATCH/DELETE /v1/admin/team` | Team member management |
| `POST /v1/providers/reload` | Hot-reload providers after key changes |
| **Regression Detection** (#152) | |
| `GET /v1/regression/status` | Opt-in state, replay-bank size, weekly spend |
| `POST /v1/regression/opt-in` | Toggle silent-regression detection |
| `GET /v1/regression/events` | Tenant-scoped regression history (`?unresolvedOnly=true`) |
| `POST /v1/regression/events/:id/resolve` | Dismiss or mark resolved with a note |
| **Cost Migrations** (#153) | |
| `GET /v1/cost-migrations/status` | Opt-in state, monthly projected savings |
| `POST /v1/cost-migrations/opt-in` | Toggle auto cost migration |
| `GET /v1/cost-migrations` | List executed migrations (active + rolled back) |
| `POST /v1/cost-migrations/run` | Trigger a migration cycle manually |
| `POST /v1/cost-migrations/:id/rollback` | Roll back a migration + clear grace boost |
| **Scheduler** (owner only) | |
| `GET /v1/admin/scheduler/jobs` | List registered jobs with last-run state |
| `POST /v1/admin/scheduler/jobs/:name/run` | Trigger a job immediately |
| **Audit** (#210) | |
| `GET /v1/audit-logs` | Tenant-scoped audit events with filters (`action`, `actor`, `since`, `until`, `cursor`, `format=json\|csv`, `limit`) — Team+ |
| **Spend** (#219) | |
| `GET /v1/spend/by` | Spend aggregation across `dim=provider\|model\|user\|token\|category` with the cross-cutting quality envelope and period-over-period delta |
| `GET /v1/spend/trajectory` | MTD + linear-run-rate projection + prior-period total + anomaly flag (Team+) |
| `GET /v1/spend/drift` | Weight-snapshot change events with per-provider spend mix in the attribution window after each (Enterprise) |
| `GET /v1/spend/recommendations` | Same-quality cheaper-alternate recommendations ranked by estimated monthly savings (Enterprise) |
| `GET /v1/spend/budgets`, `PUT /v1/spend/budgets` | Tenant budget CRUD |
| `GET /v1/spend/export` | CSV export with the same filters as `/by` |
| **Team** | |
| `GET /v1/admin/team/members` | List tenant members |
| `GET /v1/admin/team/invites` | List pending invites |
| `POST /v1/admin/team/invites` | Create an invite (owner-only, seat-limit enforced) |
| `DELETE /v1/admin/team/invites/:token` | Revoke a pending invite |
| **Billing** | |
| `POST /v1/billing/checkout-session` | Start a Stripe Checkout session |
| `POST /v1/billing/portal-session` | Start a Stripe Customer Portal session |
| `GET /v1/billing/subscription` | Current tenant subscription mirror |
| `POST /v1/webhooks/stripe` | Stripe webhook receiver (HMAC-authenticated via `STRIPE_WEBHOOK_SECRET`) |
| **Auth** (multi-tenant only) | |
| `GET /auth/login/google` | Google OAuth login (accepts `?return=&invite_token=`) |
| `GET /auth/login/github` | GitHub OAuth login (accepts `?return=&invite_token=`) |
| `POST /auth/magic-link/request` | Request a magic-link email |
| `POST /auth/magic-link/verify` | Consume a magic-link token and establish session |
| `GET /auth/saml/discover` | SSO-discover for an email's domain (returns `{sso, startUrl?}`) |
| `GET /auth/saml/:tenantId/start` | Begin SAML SSO flow for a tenant |
| `POST /auth/saml/:tenantId/acs` | SAML ACS endpoint (IdP assertion consumer) |
| `POST /auth/logout` | Sign out |
| `GET /auth/me` | Current user |
| **System** | |
| `GET /health` | Health check + mode |

The authoritative machine-readable spec lives at [`packages/gateway/openapi.yaml`](packages/gateway/openapi.yaml) — import into Yaak, Postman, or Insomnia.

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
| **Custom** | Add any OpenAI-compatible provider via dashboard | OpenAI-compatible |

## Deployment Modes

### Self-Hosted (`PROVARA_MODE=self_hosted`)

Default mode. No user accounts. Protect the dashboard with `PROVARA_ADMIN_SECRET`.

```bash
PROVARA_MODE=self_hosted
PROVARA_ADMIN_SECRET=your-secret-here
PROVARA_MASTER_KEY=<64-char-hex-key>
```

### Multi-Tenant SaaS (`PROVARA_MODE=multi_tenant`)

User accounts with Google/GitHub OAuth. Tenant-scoped data, role-based access.

```bash
PROVARA_MODE=multi_tenant
PROVARA_MASTER_KEY=<64-char-hex-key>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
OAUTH_REDIRECT_BASE=https://your-gateway.example.com
DASHBOARD_URL=https://your-dashboard.example.com

# Optional — enables transactional invite + welcome email.
# Without these, invites still work via copy-paste link from the dashboard.
RESEND_API_KEY=re_...
PROVARA_EMAIL_FROM="Provara <noreply@yourdomain.com>"
```

**Teams & invites.** Owners of a tenant can invite members from `/dashboard/team`. Seat quotas apply per tier (1 for Free, 3 for Pro, 10 for Team, unlimited for Enterprise). The invite URL (`/invite/:token`) bounces new users through OAuth; `upsertUser` atomically claims the invite when the authenticated email matches, dropping the invitee into the inviter's tenant with the assigned role. Invites expire after 7 days.

**Operator bypass.** Emails listed in `PROVARA_OPERATOR_EMAILS` (comma-separated) get an `operator` tier — all feature gates bypassed, no quota, no billing portal. Meant for internal staff accounts. Does not grant cross-tenant access; operators still only see their own tenant's data.

## Environment Variables

### Gateway

| Variable | Required | Description |
|---|---|---|
| `PROVARA_MODE` | No | `self_hosted` (default) or `multi_tenant` |
| `PROVARA_MASTER_KEY` | For key storage | 64-char hex key for encrypting API keys |
| `PROVARA_ADMIN_SECRET` | No | Protects dashboard routes in self-hosted mode |
| `DATABASE_URL` | No | libSQL/Turso URL (default: `file:provara.db`) |
| `DATABASE_AUTH_TOKEN` | For Turso | Turso auth token |
| `PORT` | No | Gateway port (default: 4000) |
| `OPENAI_API_KEY` | No | Or manage via dashboard |
| `ANTHROPIC_API_KEY` | No | Or manage via dashboard |
| `GOOGLE_API_KEY` | No | Or manage via dashboard |
| `MISTRAL_API_KEY` | No | Or manage via dashboard |
| `XAI_API_KEY` | No | Or manage via dashboard |
| `ZAI_API_KEY` | No | Or manage via dashboard |
| `OLLAMA_BASE_URL` | No | Default: `http://localhost:11434/v1` |
| `GOOGLE_CLIENT_ID` | Multi-tenant | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Multi-tenant | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | Multi-tenant | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | Multi-tenant | GitHub OAuth client secret |
| `OAUTH_REDIRECT_BASE` | Multi-tenant | Gateway public URL for OAuth callbacks |
| `DASHBOARD_URL` | Multi-tenant | Web app URL for post-login redirect |
| `PROVARA_CLOUD` | Cloud | `true` to enable Cloud-only paths (Intelligence-tier feature gates) |
| `PROVARA_OPERATOR_EMAILS` | No | Comma-separated allowlist; users with matching emails get unlimited tier bypass |
| `STRIPE_SECRET_KEY` | Cloud | Stripe API key for checkout, portal, and usage reporting |
| `STRIPE_WEBHOOK_SECRET` | Cloud | Signature secret for verifying Stripe webhook deliveries |
| `RESEND_API_KEY` | No | Enables transactional email (team invites, welcome). Without it, invites still persist and can be copy-pasted from the dashboard |
| `PROVARA_EMAIL_FROM` | No | Sender address for transactional email (default: `Provara <noreply@provara.xyz>`) — must be on a Resend-verified domain |

### Web Dashboard

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_GATEWAY_URL` | Yes | Gateway URL (browser-side) |
| `NEXT_PUBLIC_ADMIN_KEY` | Self-hosted | Must match gateway's `PROVARA_ADMIN_SECRET` |
| `GATEWAY_URL` | No | Server-side gateway URL (for SSR) |

## Generate a Master Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## License

Provara is source-available under the **Business Source License 1.1**. See [`LICENSE`](./LICENSE) for full terms.

**Plain-English summary:**

- ✅ Self-hosting for your own team or company — **allowed**
- ✅ Modifying, contributing, reading, learning from the source — **allowed**
- ✅ Building commercial applications *on top of* Provara (e.g. your own SaaS that happens to use Provara as its routing gateway) — **allowed**
- ❌ Offering Provara itself as a hosted commercial product to compete with Provara Cloud — **not allowed**

The BSL auto-converts to the MIT License four years after each version is published. Individual versions become fully permissive over time; the commercial-competition restriction applies only during the window.

Provara is operated by CoreLumen, LLC. For commercial licensing questions, contact legal@provara.xyz.
