# syntax=docker/dockerfile:1
#
# Build from the repo root:
#   docker build -f docker/pos-api.Dockerfile -t ordersail-pos-api:local .

FROM node:22-alpine AS base
WORKDIR /app

# --- deps: every workspace's package.json (full workspace graph the root
# lockfile describes), no source yet — this layer only re-runs when a
# package.json changes, not on every source edit.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/pos-api/package.json apps/pos-api/package.json
COPY apps/merchant-api/package.json apps/merchant-api/package.json
COPY apps/merchant-web/package.json apps/merchant-web/package.json
COPY apps/storefront-api/package.json apps/storefront-api/package.json
COPY apps/website/package.json apps/website/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/merchant-sdk/package.json packages/merchant-sdk/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/email-templates/package.json packages/email-templates/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/pos-sdk/package.json packages/pos-sdk/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/storefront-sdk/package.json packages/storefront-sdk/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

# --- build: full source, build shared packages this app depends on first
# (dependency order), then the app itself.
FROM deps AS build
COPY . .
RUN npm run build --workspace=config --workspace=logging --workspace=db
RUN npm run build --workspace=pos-api

# --- prod-deps: same package.json-only copy, but omit devDependencies —
# produces a lean node_modules for the runtime image.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/pos-api/package.json apps/pos-api/package.json
COPY apps/merchant-api/package.json apps/merchant-api/package.json
COPY apps/merchant-web/package.json apps/merchant-web/package.json
COPY apps/storefront-api/package.json apps/storefront-api/package.json
COPY apps/website/package.json apps/website/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/merchant-sdk/package.json packages/merchant-sdk/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/email-templates/package.json packages/email-templates/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/pos-sdk/package.json packages/pos-sdk/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/storefront-sdk/package.json packages/storefront-sdk/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci --omit=dev

# --- runtime: only what's needed to run, matching npm workspaces' symlink
# targets (node_modules/db -> ../packages/db) so module resolution works.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/apps ./apps
COPY --from=prod-deps /app/packages ./packages
COPY --from=build /app/apps/pos-api/dist ./apps/pos-api/dist
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/logging/dist ./packages/logging/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
USER app
EXPOSE 3004
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3004)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/pos-api/dist/main.js"]
