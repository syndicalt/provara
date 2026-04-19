# Provara Docs

[Fumadocs](https://fumadocs.dev)-powered documentation site for Provara. Lives at `docs.provara.xyz`.

## Local development

```bash
npm install
npm run dev -w apps/docs
```

Opens on http://localhost:3100. Hot-reloads on MDX changes.

## Content

All content lives under `content/docs/*.mdx`. Sidebar order is controlled by `content/docs/meta.json`.

- **Runbooks** mirror `docs/runbooks/*.md` at the repo root — the canonical copy lives in `docs/runbooks/` and gets ported here with frontmatter. Keep them in sync until we pick one home.
- **Features** and **API reference** are docs-site-only; the README points here for deep dives.
- **Configuration** covers every env var.

## Deploy

Configured to build on Railway as a separate service (`provara-docs`). Port 3100 by default; Railway overrides via `PORT`.
