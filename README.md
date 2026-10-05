# Ordersail

**A multi-tenant e-commerce platform: merchant back-office, storefront, POS, and payments, in one place.**

> "Everything your store needs — products, orders, inventory, and payouts, in one place."

Ordersail is a self-serve platform that lets any retailer spin up an account, catalog their products, connect a Stripe account, and start selling — with a public storefront API/app for customers and a merchant dashboard for running the store. Every account is an isolated tenant with its own catalog, inventory, orders, and Stripe Connect account; the platform itself never touches merchant funds.

Started 2026-07-07. In active early development.

---

## Goals

- **Multi-tenant from day one** — every resource (products, orders, inventory, users) is scoped to an `account`, so the same codebase serves every merchant.
- **Merchants own their money** — payments run through [Stripe Connect](https://stripe.com/connect) (Express accounts); Ordersail never holds merchant funds, only facilitates checkout and takes its cut at the payment layer.
- **Real inventory, not a single stock number** — products support options/variants (size, color, etc.), and stock is tracked per location with an auditable movement log rather than being clobbered in place.
- **A real developer API** — the storefront isn't just Ordersail's own React app; it's backed by a versioned, OpenAPI-documented API with account-scoped API keys, so a merchant (or Ordersail itself) can build any storefront against it.
- **Shipping that's actually usable** — orders carry real shipping addresses, and labels are purchased through Shippo directly from the order, with tracking numbers and URLs stored back on the order.
- **Small, sharp surface area** — an order row is only written once payment is confirmed (Stripe webhook for web, the cashier for POS), so if the row exists, it was paid — deliberately deferring complexity until it's needed.

## What's built so far

**Accounts, auth & team access**
- Multi-tenant account model — signup creates an account plus its first user
- Sign in / sign up / logout — short-lived JWT access token plus a rotating refresh token in an httpOnly cookie; "sign out other sessions" from the dashboard
- Email verification, forgot/reset password, and staff invites (accept, resend, revoke) via single-use emailed links
- MFA: TOTP with recovery codes, plus passkeys (WebAuthn); an account can require MFA for all staff
- Account profile management (name, shipping contact email); each location carries its own ship-from phone, which label purchases require
- Staff management within an account — invite, assign roles, deactivate/reactivate; each user has a personal `/app/me` profile and security page
- Custom staff roles built from a fixed permission catalog (`packages/db/src/permissions-catalog.ts`), enforced end-to-end (API guards + dashboard nav/action gating) — one fixed, non-editable `Owner` role per account, everything else account-defined
- Account-scoped developer API keys, created and revoked from the merchant dashboard
- Self-serve onboarding checklist on the dashboard home (connect Stripe, add a location, add a product)

**Catalog**
- Products with options and option values (e.g. Size, Color) and generated variants
- Full CRUD on products, variants, options, and option values
- Categories and brands, with products assignable to both
- Barcode scanner support in the merchant dashboard for fast lookups

**Inventory**
- Multi-location support (a merchant can run one store or several)
- Per-location, per-variant stock levels
- Inventory movement ledger (append-only history of stock changes, not just a mutated counter)

**Cart & checkout**
- Storefront cart API (add/update/remove items, guest cart by token) — guest checkout fully supported
- Optional customer accounts (sign up / sign in, profile, order history) layered on top of the guest cart/checkout flow
- Embedded Stripe Checkout Session creation with live shipping-rate options at checkout
- Order line items are snapshotted at purchase time (name, SKU, price, weight) so they stay accurate even if the product is later edited or deleted

**Orders & fulfillment**
- Order list/detail views scoped per account, with a financial status (`paid` → `partially_refunded` / `refunded` / `canceled`) and an append-only activity timeline (`order_events`)
- Fulfillments — an order's items can ship across one or more fulfillments; fulfillment status (unfulfilled / partially / fulfilled) is derived from them, not stored
- Shipping-rate quoting and label purchase via Shippo; tracking number, tracking URL, and label URL stored on the fulfillment
- Refunds (full or partial, via the Stripe connected account) and cancel with restock for un-fulfilled orders
- Failed orders — a checkout webhook that can't be resolved into an order lands in `failed_orders` and can be retried from the dashboard
- Business dashboard — revenue, orders, and inventory alerts (gated by `dashboard:read`)

**Payments**
- Stripe Connect (Express) onboarding per account via Stripe-hosted Account Links; balances and account management stay embedded in the dashboard
- Connect status (charges enabled / details submitted) kept in sync from `account.updated` webhooks
- One Stripe webhook endpoint (`merchant-api`, `POST /webhooks/stripe`) handling both Connect and checkout events

**Apps**
- `merchant-web` — merchant-facing dashboard (dashboard, products, inventory, orders, failed orders, carts, locations, customers, payments, staff, roles, POS devices, settings, developer API keys)
- `pos` — Expo (React Native) point-of-sale: build an order, scan or tap to add items, cash/card checkout — web and in-person sales share one orders model
- `website` — public marketing site introducing Ordersail to prospective merchants
- **`storefront-web` lives in its own repo** — [github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web), a Next.js app consuming `@ordersail/storefront-sdk` (browse products, cart, optional customer accounts, embedded Stripe checkout, order return page). It's the reference implementation, not part of this monorepo — any merchant (or Ordersail itself) can build a different storefront the same way, against `storefront-api`.

**Developer experience**
- OpenAPI specs generated from every API, with typed SDKs (`merchant-sdk`, `storefront-sdk`, `pos-sdk`) generated from them and consumed directly by the client apps
- `@ordersail/storefront-sdk` published publicly on npm — any merchant (or their developer) can build a custom storefront against `storefront-api`, hosted on any domain
- Shared `ui` component package and Drizzle-based `db` schema package used across every app
- DB-touching tests run against a real Postgres (Testcontainers) via `packages/test-support`
- Structured logging (pino) and OpenTelemetry tracing, with a local Loki + Tempo + Grafana stack for `npm run dev` — see [docs/observability.md](./docs/observability.md)

## Architecture

An Nx-managed npm workspace monorepo.

| Path | What it is | Stack |
|---|---|---|
| `apps/merchant-api` | Merchant-facing REST API, a modular monolith of six bounded contexts (see [its ARCHITECTURE.md](./apps/merchant-api/ARCHITECTURE.md)); also the single Stripe webhook endpoint | NestJS (Fastify), Drizzle, JWT |
| `apps/merchant-web` | Merchant dashboard | React 19, TanStack Router/Query/Table, Tailwind |
| `apps/storefront-api` | Public REST API consumed by storefronts — products, cart, checkout, customer accounts + orders | NestJS (Fastify), Drizzle, Stripe, Shippo |
| `apps/pos-api` | REST API for the POS app — device pairing, catalog, in-person orders | NestJS (Fastify), Drizzle |
| `apps/pos` | Point-of-sale app — pairs to the account, builds orders, cash/card checkout | Expo / React Native |
| `apps/worker` | Background job consumer — order processing + transactional email; exposes `GET /health` only | NestJS (Fastify), BullMQ |
| `apps/website` | Marketing site | Astro |
| `packages/db` | Shared Postgres schema & migrations (single source of truth for every API) | Drizzle ORM, Postgres 17 |
| `packages/merchant-sdk` / `storefront-sdk` / `pos-sdk` | Typed clients generated from each API's OpenAPI spec | openapi-typescript |
| `packages/config` | `parseEnv(service, zodSchema)` — validate env at boot, fail fast | zod |
| `packages/payments` | Shared Stripe surface — pinned API version, client factory, webhook signature verification | stripe |
| `packages/password-policy` | Shared password rules for merchant and customer auth | — |
| `packages/test-support` | Jest helpers — Testcontainers Postgres harness (`useTestDb`) + row fixtures; source-only, never shipped | Testcontainers |
| `packages/queue` | Shared BullMQ queue names + job type definitions | BullMQ, ioredis |
| `packages/storage` | S3/MinIO client wrapper — presigned uploads, public-read bucket | AWS SDK v3 |
| `packages/email` / `email-templates` | Nodemailer transport + React Email templates | nodemailer, react-email |
| `packages/logging` | pino logger + correlation-ID context shared by the NestJS apps (see `docs/observability.md`) | pino |
| `packages/errors` | The API error envelope ([ADR 0001](./docs/adr/0001-api-error-envelope.md)) — code registry, `ApiException`, `useApiErrors` (validation + the global filter every API registers), OpenAPI `ErrorResponse` | NestJS |
| `packages/tracing` | OpenTelemetry setup — pinned instrumentations (HTTP, Fastify, pg), span-attribute allow-list, OTLP export; off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (see `docs/observability.md`) | OpenTelemetry |
| `packages/seed` | Local dev seed — demo "Sneaker Depot" catalog + images | tsx |
| `packages/ui` | Shared component library used by both React apps | React, Tailwind |

**Data model highlights** (`packages/db/src/schema`): `accounts` and `users` anchor multi-tenancy; `roles`/`permissions` back RBAC; `products` → `product_options`/`product_option_values` → `product_variants` model catalog variation; `categories` and `brands` classify products; `locations` + `inventory` + `inventory_movements` track stock with history; `carts`/`cart_items` are ephemeral pre-purchase state while `orders`/`order_items` are permanent, snapshotted records — web and POS sales share one `orders` table (a `channel` enum), with `order_shipping`, `order_payments`, `order_events`, and `fulfillments` as children; `stripe_accounts` links an account to its Stripe Connect account (a missing row simply means "not connected yet"); `account_api_keys` scopes storefront API access per account.

`storefront-web` isn't in the table above — it's an external consumer of `storefront-api` in its own repo, not part of this workspace. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how it fits in the system map.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the full system map (service-to-service edges, queues, third-party calls)
- [apps/merchant-api/ARCHITECTURE.md](./apps/merchant-api/ARCHITECTURE.md) — merchant-api's bounded contexts and the lint-enforced rules between them
- [docs/observability.md](./docs/observability.md) — logging, correlation IDs, tracing, and the local Grafana stack
- [docs/personas/](./docs/personas/README.md) — who we're building for: merchant owner, merchant staff, storefront shopper, POS cashier, storefront developer
- [docs/runbooks/](./docs/runbooks/) — operational runbooks (alerts, refunds/disputes, environment on/off, web checkout)

## Getting started

### Prerequisites

- **Node ≥ 22.12** and **npm 11** — the repo pins `npm@11.6.0` via `packageManager`,
  so `corepack enable` (or `npm i -g npm@11`) once, since Node 22 still ships npm 10.
- **Docker** with Compose v2 — for the local Postgres / Redis / MinIO / Mailpit / Grafana stack, and for the test suites (Testcontainers boots a throwaway Postgres).

### Quickstart

All commands run from the repo root.

```bash
npm ci
npm run setup       # .env from every .env.example — placeholder secrets, see "Secrets"
npm run up          # Postgres + Redis + MinIO + Mailpit + local Loki/Tempo/Grafana (waits until healthy)
npm run bootstrap   # wait for Postgres, drizzle push, seed the demo catalog
                    #  ↳ copy the "Created storefront API key: sfk_…" line it prints
npm run dev         # the five coupled app servers, in parallel
```

**Storefront is a separate clone.** `storefront-web` isn't part of this repo —
clone [github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web)
alongside this one and set its `.env.local` from the `sfk_…` key `bootstrap` printed
(`NEXT_PUBLIC_APP_KEY`) plus `NEXT_PUBLIC_STOREFRONT_API_URL=http://localhost:3001`. See
[docs/runbooks/web-checkout.md](./docs/runbooks/web-checkout.md) for the full,
copy-pasteable local flow.

**Demo login:** `owner@sneakerdepot.test` / `password123` at http://localhost:5000.

### Ports

| Service | URL | Notes |
| --- | --- | --- |
| merchant-web | http://localhost:5000 | merchant dashboard |
| merchant-api | http://localhost:3000 | Swagger UI at `/swagger` |
| storefront-api | http://localhost:3001 | Swagger UI at `/swagger` |
| pos-api | http://localhost:3004 | |
| worker | http://localhost:3003 | `GET /health` only |
| website | http://localhost:4321 | `npm run dev:website` (separate) |
| storefront-web | pick a free port (e.g. `:3010`) | separate clone, own repo — `:3000` is already merchant-api's |
| Postgres | `localhost:5432` | `postgres` / `postgres`, db `ordersail` |
| Redis | `localhost:6379` | |
| MinIO | http://localhost:9000 · console http://localhost:9001 | `minioadmin` / `minioadmin` |
| Mailpit | http://localhost:8025 | catches all outbound dev email |
| Grafana | http://localhost:3300 | logs (Loki) and traces (Tempo) from `npm run dev` — see [docs/observability.md](./docs/observability.md#logs-in-local-grafana) |
| Tempo | `localhost:4318` | OTLP/HTTP receiver the services export traces to |

### Standalone apps — website, pos & storefront-web

`npm run dev` runs the five coupled apps; these start on their own:

- **`npm run dev:website`** — Astro marketing site (`:4321`). It's a standalone
  persistent server; stop it with `cd apps/website && npx astro dev stop`.
- **`npm run dev:pos`** — Expo point-of-sale app. Needs `pos-api` running plus
  Expo Go on a device or an iOS/Android simulator. An Android emulator reaches the
  host via `10.0.2.2` (already set in `apps/pos/.env.example`).
- **`storefront-web`** — not in this repo at all; clone
  [github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web)
  separately and run its own `npm run dev` (see "Storefront is a separate clone" above).

### Secrets

The placeholder `.env` files are enough to run the catalog, cart, dashboard, POS,
and seed. Stripe Connect onboarding, checkout, and Shippo label purchase need real
**test-mode** credentials:

- APIs (`apps/merchant-api/.env`, `apps/storefront-api/.env`): `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` (merchant-api only — the one Stripe webhook endpoint),
  `SHIPPO_API_KEY`
- `apps/merchant-web/.env`: `VITE_STRIPE_PUBLISHABLE_KEY`
- the separately-cloned `storefront-web` repo's `.env.local` (see its own
  `.env.example`): `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_KEY`
  (the `sfk_…` from `npm run bootstrap`), `NEXT_PUBLIC_STOREFRONT_API_URL=http://localhost:3001`

Forward Stripe webhooks locally with `npm run stripe:listen -w merchant-api`
(account.updated + checkout.session.* → `POST /webhooks/stripe`).

### Everyday tasks

`npm run down` · `npm run reset` (wipe volumes + re-seed) · `npm run logs` ·
`npm run build` · `npm run typecheck` · `npm run lint` · `npm run test` ·
`npm run push` / `npm run migrate` · `npm run seed` · `npm run verify:contracts`

Each NestJS API exposes Swagger/OpenAPI at runtime and has a `generate:openapi` script that regenerates `openapi.json`, which in turn feeds the corresponding SDK package.

## Deployment

AWS (ECS Fargate + CloudFront), provisioned with Terraform and shipped by GitHub
Actions (`.github/workflows/cd.yml`). See
[infra/terraform/README.md](./infra/terraform/README.md) for the layer layout,
the required repo/environment configuration, and the RDS / CloudFront runbooks.

## Roadmap

- Tax handling beyond what Stripe Checkout quotes directly
- Storefront theming/templates on top of `@ordersail/storefront-sdk` (the SDK is live; there's no themeable starter beyond `storefront-web` itself yet)
- A unified, Stripe-style API error contract across all three APIs
- Public self-serve launch (lifting the pre-launch gate, SES production access)
