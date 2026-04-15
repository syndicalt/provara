FROM node:22-slim AS base

# ── Install dependencies ──────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/db/package.json ./packages/db/

RUN npm ci --workspace=packages/gateway --workspace=packages/db --include-workspace-root

# ── Build ─────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/gateway/node_modules ./packages/gateway/node_modules

COPY package.json package-lock.json tsconfig.json ./
COPY packages/gateway ./packages/gateway
COPY packages/db ./packages/db

RUN npm run build -w packages/gateway

# ── Prune dev dependencies ────────────────────────────────────
FROM base AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/db/package.json ./packages/db/

RUN npm ci --workspace=packages/gateway --workspace=packages/db --include-workspace-root --omit=dev

# ── Run ───────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./

COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder /app/packages/gateway/package.json ./packages/gateway/

COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle

EXPOSE 4000

CMD ["node", "packages/gateway/dist/index.js"]
