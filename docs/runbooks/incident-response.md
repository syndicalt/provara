# Operator runbook: incident response

Top-level playbook for "the gateway is broken". Work top-down — most recent incidents have had simple causes. Specific cross-cutting runbooks (master-key rotation, DB backup/restore) are linked at the end.

## 1. Confirm scope

Before you troubleshoot anything, confirm blast radius.

```sh
# Does the gateway respond to /health?
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://gateway.provara.xyz/health

# Is the dashboard up?
curl -sS -o /dev/null -w "%{http_code}\n" https://www.provara.xyz
```

- Both return `200` → the platform is up, the incident is likely feature-level (a specific provider is down, a customer-specific query). Go to §5.
- Gateway 5xx / timeout → §2.
- Dashboard 5xx but gateway fine → §6.
- Both down → §3.

## 2. Gateway is down

**Check Railway deploy status first.** The most common cause is that the latest deployment crashed and Railway stopped retrying.

```sh
railway status --json | grep -E '"status"|"commitMessage"' | head -10
```

- `"status": "SUCCESS"` and recent `createdAt` → deploy is live, something else is wrong; check logs in §2.3.
- `"status": "CRASHED"` with `deploymentStopped: true` → §2.1.
- `"status": "DEPLOYING"` for >5 min → §2.2.

### 2.1 Gateway crashed and Railway gave up

```sh
railway logs --service provara-gateway --deployment | tail -50
```

Common crash causes (April 2026 dataset):

| Log contains | Root cause | Fix |
|---|---|---|
| `SQL write operations are forbidden (writes are blocked, do you need to upgrade your plan?)` | Turso write-quota exhausted | Enable overages or upgrade plan in [app.turso.tech](https://app.turso.tech/account/billing) — then redeploy |
| `PROVARA_MASTER_KEY is required` | Env var was removed or emptied on Railway | Restore the env var, redeploy |
| `Error: listen EADDRINUSE` | Port collision (shouldn't happen on Railway, but can happen mid-rollout) | Redeploy — it'll grab a fresh container |
| `Cannot find module` / `Error: Could not resolve` | Bad build (usually a missing dep in `package.json`) | Look at the most recent merged PR; roll it back if you can't fix forward in <5 min |

Once fixed, redeploy:

```sh
railway redeploy --service provara-gateway --environment production
```

### 2.2 Gateway stuck deploying

- Look at the build log in the Railway dashboard. A hanging `npm ci` usually means a registry outage; wait 10 min and retry.
- If a test is running as part of CI and hanging: kill the deploy in the dashboard and check the failing test locally first.

### 2.3 Gateway serving 5xx but process looks healthy

```sh
railway logs --service provara-gateway | tail -100
```

Look for:

- **Repeated `LibsqlError`** — DB is down or blocked. Check Turso status page + quota.
- **Repeated `[provider] ... failed`** — an upstream provider is down. Router's fallback should handle it; if it isn't, check whether all candidate providers for a common cell are down at once.
- **Memory leak** — rare, but a slow RAM climb over hours can cause OOM restarts. Railway shows restart count; if >5 in the last hour, restart manually and open an issue.

## 3. Full platform outage

If both the gateway and dashboard are down, check upstream providers first:

- [Turso status](https://status.turso.tech) — if their API is down, nothing we write or read works
- [Railway status](https://status.railway.app) — deploys and serves everything
- [Vercel status](https://status.vercel.com) — not currently used for web, but OAuth redirect URLs can traverse their CDN
- [Resend status](https://resend.com/status) — email-only, doesn't affect gateway availability but blocks new signups

If everything upstream is green and we're still fully down, it's probably a Railway networking issue with our project specifically — open a Railway support ticket with the project + deployment IDs from `railway status --json`.

## 4. Database quota exhausted

**Symptom:** gateway crash-loop, logs show `SQL write operations are forbidden`.

**Fix in place:** go to [Turso org billing](https://app.turso.tech/account/billing) and either (a) enable overages on the current plan, or (b) upgrade to the next tier. Overages unblock instantly. Then redeploy the gateway:

```sh
railway redeploy --service provara-gateway --environment production
```

**Follow-up:** file (or reuse) the write-hot-paths audit issue. Hitting the Starter quota on near-zero traffic is a signal of over-writing elsewhere in the code.

## 5. Feature-level incident

Platform up, specific feature broken. Examples from past incidents:

- **"Chat completions return 402 budget_exceeded unexpectedly"** — `GET /v1/spend/budgets` for the affected tenant; check if `hard_stop=true` and spend >= cap.
- **"Invite flow silently drops"** — ask the user whether they signed in with the email the invite was sent to; if not, they should see the `/dashboard?invite_status=wrong_email` banner. If they don't, the token may not have threaded through — check the `/auth/login/*` handler stored `provara_oauth_invite` cookie.
- **"Dashboard provider-key decrypt fails"** — either the DB was restored without the matching `PROVARA_MASTER_KEY`, or rotation completed but the env var wasn't swapped. See `master-key-rotation.md` failure modes.
- **"Rate-limit 429s on normal traffic"** — look at `RATE_LIMIT_*` env vars; if someone tightened them mid-incident, they may still be tight. Defaults: `AUTH_PER_MIN=20`, `CHAT_RPS=200`, `INVITE_PER_MIN=20`.

## 6. Dashboard down, gateway fine

- Check the web service's Railway status; it's a separate service (`provara-web`).
- Most dashboard outages are build failures — the Next app is stateless and recovers cleanly on redeploy.

## Related runbooks

- [Master-key rotation](master-key-rotation.md)
- [Adding a provider](adding-a-provider.md)
- [Backup & restore](backup-restore.md)
