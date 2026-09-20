# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ordersail — a multi-tenant e-commerce platform (merchant back-office, storefront API, POS, payments)
as an Nx-managed npm workspace monorepo. Every resource is scoped to an `account`; payments run
through Stripe Connect (Express), so the platform never holds merchant funds.

These carry the detail and are worth reading before non-trivial work:

- [README.md](./README.md) — what's built, the app/package table, ports, local setup, secrets
- [ARCHITECTURE.md](./ARCHITECTURE.md) — system map, service edges, the order + email job flow
- [apps/merchant-api/ARCHITECTURE.md](./apps/merchant-api/ARCHITECTURE.md) — the bounded contexts
  and their enforced dependency rules (read this before touching `merchant-api`)
- [docs/observability.md](./docs/observability.md) — logging and correlation IDs across API → queue → worker

## Commands

**Node ≥ 22.12 and npm 11** — the repo pins `npm@11.6.0` via `packageManager`. Node 22 ships npm 10,
whose `npm ci` cannot reconcile this lockfile's `overrides`. Run `npm install -g npm@11` once.

All of these run from the repo root:

```bash
npm ci
npm run setup       # .env from every .env.example
npm run up          # Postgres + Redis + MinIO + Mailpit, waits until healthy
npm run bootstrap   # wait for Postgres, drizzle push, seed the demo catalog
npm run dev         # merchant-api, storefront-api, pos-api, worker, merchant-web in parallel
npm run reset       # wipe volumes, re-up, re-bootstrap
```

`website` and `pos` are standalone: `npm run dev:website` (Astro, `:4321`) and `npm run dev:pos`
(Expo). `storefront-web` is **not in this repo** — it's a separate clone at
[github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web).

### Verify

```bash
npm run build      # nx run-many -t build
npm run typecheck  # nx run-many -t typecheck
npm run lint       # nx run-many -t lint:ci
npm run test       # nx run-many -t test
```

Scope to one project with nx directly: `npx nx test merchant-api`, `npx nx typecheck merchant-web`.
CI runs `nx affected -t build lint:ci typecheck test --exclude=pos` against the PR merge-base.

### Running a single test

The NestJS apps use jest with `rootDir: src`, so the path filter is a regex against the spec path:

```bash
npm test -w merchant-api -- auth.service          # one spec file
npm test -w merchant-api -- -t "rejects a stale"  # one test by name
npm test -w merchant-api -- --watch
```

**Docker must be running.** Jest's `globalSetup` boots a throwaway Postgres via Testcontainers
(`packages/test-support/src/test-db/`), applies the real drizzle migrations, and exports
`DATABASE_URL` to the workers. These apps run `maxWorkers: 1` because they share that one database.

### Database

`packages/db` is the single source of truth for schema across every API.

```bash
npm run push      # drizzle-kit push — local dev, no migration file
npm run migrate   # drizzle-kit migrate — apply committed migrations
npm run studio    # drizzle-kit studio
npm run seed
```

Generate a migration with `npm run generate -w db` after changing `packages/db/src/schema/`.

### OpenAPI → SDK codegen loop

Each NestJS API generates its own spec, which feeds the matching typed SDK package. After changing
any controller or DTO:

```bash
npm run generate:openapi -w merchant-api   # rewrites apps/merchant-api/openapi.json
npm run generate -w merchant-sdk           # regenerates packages/merchant-sdk/src/types.gen.ts
```

Same pairing for `storefront-api`/`storefront-sdk` and `pos-api`/`pos-sdk`. The client apps import
the SDK, not the API — a controller change that skips this loop leaves the frontend typed against
a stale contract. `@ordersail/storefront-sdk` is **published publicly on npm** (via OIDC Trusted
Publishing, `.github/workflows/publish-storefront-sdk.yml`), so its surface is a public API.

## Architecture

### Service topology

There is **no backend-to-backend HTTP traffic**. `merchant-api` and `storefront-api` never call each
other; the only inter-service calls are frontend → its own API, through a generated SDK. Contexts
that must share work do so through Postgres or BullMQ.

The async order path spans two processes. `merchant-api` owns the whole webhook-to-enqueue leg:
`payments/stripe-webhook.controller.ts` is the single Stripe event destination (`POST /webhooks/stripe`)
and emits a domain event; `sales/checkout-orders` resolves it and enqueues to the `orders` queue;
`worker` writes the order + inventory movements in one transaction, enqueues to the `email` queue,
then renders and sends. Idempotency rests on `stripeCheckoutSessionId` and the
`confirmationEmailQueuedAt` flag, so a stalled-job redelivery retries the email without duplicating
the order. Unresolvable webhooks land in `failed_orders` for retry from the dashboard.

Note: the root ARCHITECTURE.md sequence diagram still shows this webhook in `storefront-api`. That
moved to `merchant-api` (Linear M9); the diagram is stale, the code above is current.

`email` and `email-templates` are imported **only** by `worker`. The APIs only ever enqueue email
jobs — they never touch SMTP.

A `worker` that crashes at boot silently kills all email (invites, order confirmations) while
everything else looks healthy. Check `curl localhost:3003/health`, which verifies each queue's
consumption loop is actually draining, not just that Redis responds to a ping.

### merchant-api is a modular monolith

`src/` is six bounded contexts (`identity`, `catalog`, `stock`, `sales`, `payments`, `platform`)
plus a shared kernel (`shared/`). This was a deliberate choice over splitting into services.

Two rule sets are enforced by ESLint and will fail `lint:ci`:

1. **Context boundaries** (`eslint-plugin-boundaries`). A context may import its own files freely
   and the shared kernel, but reaches another context **only through that context's `index.ts`
   barrel** — never a deep path. Only the declared edges are allowed. The shared kernel is a leaf
   and may not import a context.
2. **The data-access read-graph** (`no-restricted-imports`). `packages/db` exposes a per-domain
   entrypoint per context (`db/identity`, `db/catalog`, `db/stock`, `db/sales`, `db/payments`). A
   context imports its own `db/<domain>` plus the entrypoints on its read-graph. Root `db` and
   `db/schema` are blocked in every context — they're the full schema, for `platform/dashboard`,
   migrations, and the other apps.

Calling another context's services goes through an **adapter behind a local port**: the consumer
defines the port interface, an adapter in the consumer's `ports/` folder delegates to the producer's
barrel, and the consumer's domain code depends only on the port. Live edges are
`platform/dashboard → sales` and `sales → payments` (refunds).

Adding a cross-context edge means updating **both** the table in `apps/merchant-api/ARCHITECTURE.md`
and the policies in `apps/merchant-api/eslint.config.mjs` — they must agree.

### Data model

`accounts` and `users` anchor multi-tenancy. Web and POS sales share **one** `orders` table
distinguished by a channel enum, with `order_shipping` / `order_payments` as children. Order line
items are snapshotted at purchase time (name, SKU, price, weight) so they survive later product
edits. Stock is a ledger — `inventory` plus an append-only `inventory_movements` — not a mutated
counter. A missing `stripe_accounts` row simply means "not connected yet".

## Conventions

- **Naming**: the project was renamed from "shop" to Ordersail. Rename any `shop-*` identifier you
  touch to `ordersail-*`; the old name is being purged. The merchant app is `merchant-*`, not `admin-*`.
- **Branch off `main`, PR into `main`.** Do not stack PRs on other PR branches — stacked merges
  have silently lost commits in this repo twice. Land sequentially, or use one PR with per-issue commits.
- **Issues are tracked in Linear**, not GitHub Issues (GitHub is for PRs). Reference the identifier
  in commits and branches: `feat(merchant-api): ... (OS-494)`, `noelvegajr94/os-494-<slug>`.
- **Re-run `npx tsc --noEmit` after adding or editing `.spec.ts` files.** ts-jest accepts casts that
  raw `tsc` rejects, so a green test run can still break CI's typecheck.
- **Use `useTestDb()` from `test-support`** in DB-touching specs. It gives each test a clean database
  (TRUNCATE ... RESTART IDENTITY CASCADE) and closes the pool. Extract reusable test helpers into
  `packages/test-support` rather than copy-pasting them per spec.
- When mocking a library boundary, fixtures must use the **real wire encoding** — a fixture in the
  wrong encoding produces a green suite that agrees with the bug.
- Pre-launch, with no real users: prefer the correct design over backward compatibility. Breaking
  local/test data is fine.

## Agent skills

### Issue tracker

Issues live in Linear (team **OrderSail**, issue ids `OS-###`), accessed through the Linear MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` pointing at per-context `CONTEXT.md` files. See `docs/agents/domain.md`.
