# Contributing to Provara

Provara is a self-hostable LLM operations platform. Contributions are welcome across three surfaces: the gateway, the web dashboard, and docs. This doc covers what you need to know.

## License

Provara is licensed under the **Business Source License 1.1** (BSL). In short:

- **Non-production use** (evaluation, development, internal experimentation): free and unrestricted.
- **Production use:** free for individuals and small organizations. Commercial production use by larger organizations requires a license from CoreLumen, LLC (legal@corelumen.io).
- **Change date:** each release converts to Apache 2.0 four years after its release date.

If this model isn't compatible with how you want to use Provara, reach out — there's a path for most cases.

By submitting a pull request, you agree that your contribution will be licensed under the same BSL terms as the rest of the project.

## Ways to contribute

| You want to… | Go here |
|---|---|
| Report a bug | [GitHub Issues](https://github.com/syndicalt/provara/issues/new) — include repro steps, logs, and `provara --version` if you self-host |
| Propose a feature | Open an issue first with the `[shiplog/plan]` prefix and include context / alternatives / open questions — see `.shiplog/routing.md` for the brainstorm protocol |
| Fix a bug or ship a small feature | Send a PR directly (see below) |
| Add a provider | See [`docs/runbooks/adding-a-provider.md`](docs/runbooks/adding-a-provider.md) |
| Improve docs | PRs directly against the README, `docs/runbooks/`, or the OpenAPI spec |

## Development setup

```sh
git clone https://github.com/syndicalt/provara.git
cd provara
npm install

# Set up environment
cp .env.example .env
# Edit: PROVARA_MASTER_KEY + at least one provider API key

# Run DB migrations on a local SQLite (default)
npm run db:migrate -w packages/db

# Start everything
npx turbo dev
```

- **Gateway:** http://localhost:4000
- **Dashboard:** http://localhost:3000
- **DB Studio** (Drizzle's UI): `npm run db:studio -w packages/db`

## Test expectations

- **Gateway tests must pass** before opening a PR: `npm test -w packages/gateway` (503+ tests, runs in ~25–45s).
- **Web typecheck must pass**: `cd apps/web && npx tsc --noEmit`.
- **Gateway typecheck must pass**: `npx tsc --noEmit -p packages/gateway`.
- **New features should ship with tests.** The existing suite has strong coverage patterns — use the nearest-neighbor test file as a template.

The CI workflow runs typecheck + tests on every PR (`.github/workflows/ci.yml`). GitGuardian also scans for committed secrets.

## Commit + PR conventions

Provara follows the **shiplog** workflow — the full protocol lives at [`.shiplog/routing.md`](.shiplog/routing.md) but the short version:

- **Branch:** `issue/<N>-<slug>` (e.g. `issue/189-oauth-invite-mismatch`)
- **Commit title:** `<type>(#<N>): <message>` (e.g. `feat(#189): detect wrong-OAuth-account on invite claim`)
- **Commit body:** explain the *why*, not the *what*. Include design decisions, tradeoffs considered, and what's explicitly out of scope. See the recent merged PRs for examples.
- **PR body:** summary + changes + test plan + any deferred follow-ups. Link the issue with `Closes #<N>`.
- **Authorship signatures** at the bottom of commits/PRs: `Authored-by: <name>`, `Last-code-by: <name>`.

Pre-commit hooks check typecheck + tests. Don't skip them (`--no-verify`) unless you have a very good reason documented in the PR.

## Code style

- **TypeScript everywhere.** The gateway is ESM + `type: "module"`; the web app is Next.js App Router.
- **No unnecessary comments.** Most of the codebase follows the convention that comments explain *why* (hidden constraints, surprising behavior, design tradeoffs) — not *what* the code does. See any file under `packages/gateway/src/routing/` for the style.
- **Prefer editing existing files over creating new ones.** Small features usually belong in the nearest module.
- **No premature abstractions.** Three similar lines beat a premature helper.
- **No feature flags or backwards-compatibility shims** when you can just change the code. Self-hosters get bumped by the migration; that's fine.

## Architecture recap

See the root `README.md` for the full picture. The elevator version:

- **`packages/gateway`** — Hono proxy on port 4000. Provider adapters auto-register from env + DB-stored keys. Routing, auth, scheduler, audit, spend, rate limit, budgets all live here.
- **`packages/db`** — Drizzle ORM + libSQL/SQLite. Migrations in `packages/db/drizzle/`.
- **`apps/web`** — Next.js + Tailwind dashboard. Uses the gateway's REST API via `lib/gateway-client.ts`.

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** Email security@corelumen.io instead. We'll acknowledge within 48 hours, fix, and coordinate disclosure.

## Questions

- General: open a discussion or hit the team email at legal@corelumen.io (yes, legal is currently the catch-all — this will split out as volume grows)
- Real-time: we don't currently run a public Slack/Discord; watch the releases page for updates.
