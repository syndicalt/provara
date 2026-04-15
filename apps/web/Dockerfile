FROM node:22-slim AS base

# ── Install dependencies ──────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/

RUN npm ci --workspace=apps/web --workspace=packages/db --include-workspace-root

# ── Build ─────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json package-lock.json tsconfig.json ./
COPY apps/web ./apps/web
COPY packages/db ./packages/db

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build -w apps/web

# ── Run ───────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
