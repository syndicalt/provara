# Self-host vs. Provara Cloud — picking your path

Provara ships two ways. This page helps you pick.

## The short answer

| You… | Pick |
|---|---|
| Want the gateway + dashboard running on your own infrastructure, single-tenant, no third-party hop | **Self-host** |
| Want a managed URL to point your SDK at, dashboard pre-configured, we handle ops | **Provara Cloud** (Team+ tier for full feature set) |
| Have a compliance/data-residency requirement that prevents prompts from traversing a third party | **Self-host**, period |
| Are an individual or small team evaluating the product | **Self-host for free** or **Cloud Free tier** — pick whichever's faster for you |

## Feature parity

Both paths run the same codebase. The intelligence features (adaptive routing, A/B tests, silent-regression detection, cost migration, semantic cache, audit logs, spend intelligence) are in the OSS gateway and work on both. Tier-gated features on Cloud are gated on self-host too, but with different enforcement — see "Licensing & tier gates" below.

| Feature | Self-host | Cloud Free | Cloud Pro | Cloud Team | Cloud Enterprise |
|---|---|---|---|---|---|
| Gateway + dashboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| BYOK providers | ✅ | ✅ | ✅ | ✅ | ✅ |
| Adaptive routing | ✅ | ✅ | ✅ | ✅ | ✅ |
| A/B tests (manual + auto) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Silent-regression detection | ✅ | ❌ | ✅ | ✅ | ✅ |
| Auto cost migration | ✅ | ❌ | ✅ | ✅ | ✅ |
| Guardrails (PII, content, regex) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Audit logs | ✅ (unlimited retention) | ❌ | ❌ | ✅ (365 d) | ✅ (730 d) |
| Spend intelligence (provider/model/category) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Per-user/per-token spend attribution | ✅ | ❌ | ❌ | ❌ | ✅ |
| Weight-drift analysis | ✅ | ❌ | ❌ | ❌ | ✅ |
| Savings recommendations | ✅ | ❌ | ❌ | ❌ | ✅ |
| Budgets + alerts + hard-stop | ✅ | ❌ | ❌ | ✅ | ✅ |
| SAML SSO | ✅ | ❌ | ❌ | ❌ | ✅ |
| Managed ops (we handle uptime, scaling) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Monthly request quota | Your infra | 10,000 | 100,000 | 500,000 | Custom |
| Overage billing | — | Hard cutoff | $0.50 / 1k | $0.50 / 1k | Custom |

The "Cloud Free" restrictions on intelligence features are the **monetization boundary**, not a capability gap. The code to run adaptive routing + regression + cost migration exists in every deployment; Cloud enforces tier gates via `requireIntelligenceTier` / `requireEnterpriseTier` middleware and a live Stripe subscription. Self-host deployments skip these gates entirely — run everything.

## When self-host wins

- **Data residency / compliance.** Prompts and responses never leave your perimeter. This is load-bearing for healthcare, finance, public sector, and many EU buyers.
- **Cost at scale.** If your monthly request volume is large enough that the Cloud overage rate ($0.50 / 1k) exceeds your fully-loaded ops cost for running a gateway, self-host is cheaper.
- **Custom providers.** Self-host lets you wire up any OpenAI-compatible endpoint (including on-prem or open-weights inference you're running yourself). Cloud supports BYOK to any public provider, but not on-prem endpoints on our network.
- **Full audit retention.** Self-host can keep audit logs indefinitely — retention is an app-level policy you control. Cloud tiers cap retention per plan.
- **Modify the code.** BSL allows non-production modification freely; commercial production modification requires a conversation with us. Either way you have the source.

## When Cloud wins

- **Fast to "hello world."** Sign up → click "Add Google OAuth key" → send your first completion through a gateway we're operating. No infra to set up.
- **No ops burden.** Turso, Railway, Stripe, Resend — all configured. You get the URL, dashboard, invites flow, SSO config, email template, and webhook pipeline for free.
- **Intelligence features pre-tuned.** Regression thresholds, migration safety windows, replay bank sampling — all defaulted sensibly with monitored infra so we can tune if we see weirdness. Self-hosters tune their own.
- **Upgrades handled.** When we ship `feat(#N)` we deploy it; you get it. Self-host upgrades are a `git pull` + migrate + redeploy you have to do yourself.
- **Compliance story.** Cloud ships with a documented SOC 2-aligned audit log, encrypted key storage, and tier-gated retention. Useful for buyers whose procurement will ask.

## Moving between them

- **Cloud → self-host.** Export your data: dashboard → Settings → Export Data (dumps tenant rows + subscription snapshot). Run the gateway locally, import the dump, point SDK clients at your URL. We don't lock your data in.
- **Self-host → Cloud.** Create a Cloud account, use the same Export → Import flow in reverse. Because the schemas are identical, the import is a straight row copy under a new `tenant_id`.

## Licensing & tier gates

Self-host and Cloud use the same BSL-licensed source. The difference is enforcement:

- **Self-host** checks `PROVARA_CLOUD=false` (default) and bypasses tier gates. Everything is available. Modification is permitted for non-production use; commercial production use requires a license.
- **Cloud** runs with `PROVARA_CLOUD=true` and enforces `requireIntelligenceTier` / `requireEnterpriseTier` based on the tenant's Stripe subscription.

Code architecture: there's no split repo and no license gate at build time. The tier checks are `if (isCloudDeployment()) { enforce; } else { pass; }`. This means self-hosters get every intelligence feature unlocked by default.

## Still not sure?

Spin up self-host in 5 minutes (see `README.md` → Quick Start), kick the tires, and if you decide you'd rather we operate it — open a Cloud account. Your data migrates cleanly.
