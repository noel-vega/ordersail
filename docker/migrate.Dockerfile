# syntax=docker/dockerfile:1
#
# Applies packages/db's versioned migrations (drizzle-kit migrate) against
# DATABASE_URL. Distinct shape from the app Dockerfiles: needs drizzle-kit
# itself (a devDependency) plus the raw drizzle/ SQL folder, neither of which
# survive a `tsc` build or a --omit=dev install.
#
# Build from the repo root:
#   docker build -f docker/migrate.Dockerfile -t ordersail-migrator:local .

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/pos-api/package.json apps/pos-api/package.json
COPY apps/merchant-api/package.json apps/merchant-api/package.json
COPY apps/merchant-web/package.json apps/merchant-web/package.json
COPY apps/storefront-api/package.json apps/storefront-api/package.json
COPY apps/website/package.json apps/website/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/merchant-sdk/package.json packages/merchant-sdk/package.json
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
COPY packages/db packages/db
WORKDIR /app/packages/db
CMD ["npx", "drizzle-kit", "migrate"]
