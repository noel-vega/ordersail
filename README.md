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
- **Small, sharp surface area** — one payment status per order (Stripe webhook confirms payment, so if the row exists, it was paid), no order history for customers yet — deliberately deferring complexity until it's needed.

## What's built so far

**Accounts, auth & team access**
- Multi-tenant account model — signup creates an account plus its first user
- JWT-based sign in / sign up / logout / token refresh
- Account profile management (name, shipping contact phone/email — required up front since some carriers reject label purchases without it)
- User management (list, view, update, delete) within an account
- Custom staff roles built from a 28-key permission catalog, enforced end-to-end (API guards + dashboard nav/action gating) — one fixed, non-editable `Owner` role per account, everything else account-defined
- Account-scoped developer API keys, issued and viewable from the merchant dashboard

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
- Optional customer accounts (sign up / sign in, profile) layered on top of the guest cart/checkout flow — no order-history view for customers yet
- Embedded Stripe Checkout Session creation with live shipping-rate options at checkout
- Order line items are snapshotted at purchase time (name, SKU, price, weight) so they stay accurate even if the product is later edited or deleted

**Orders & fulfillment**
- Order list/detail views scoped per account
- Shipping-rate quoting and label purchase via Shippo, directly from an order
- Tracking number, tracking URL, and label URL stored back on the order once purchased
- Refund and cancel flows — full refund via the Stripe connected account, restock-on-cancel for un-fulfilled orders (partial/line-item refunds not yet supported)

**Payments**
- Stripe Connect (Express) onboarding per account, via embedded Stripe Connect components
- Connect status polling (charges enabled / details submitted)
- Stripe webhook handling for both the platform (account onboarding) and per-account checkout events

**Apps**
- `merchant-web` — merchant-facing dashboard (products, inventory, orders, carts, locations, customers, payments, roles, settings, developer API keys)
- `pos` — Expo (React Native) point-of-sale: build an order, scan or tap to add items, cash/card checkout — web and in-person sales share one orders model
- `website` — public marketing site introducing Ordersail to prospective merchants
- **`storefront-web` lives in its own repo** — [github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web), a Next.js app consuming `@ordersail/storefront-sdk` (browse products, cart, optional customer accounts, embedded Stripe checkout, order return page). It's the reference implementation, not part of this monorepo — any merchant (or Ordersail itself) can build a different storefront the same way, against `storefront-api`.

**Developer experience**
- OpenAPI specs generated from every API, with typed SDKs (`merchant-sdk`, `storefront-sdk`, `pos-sdk`) generated from them and consumed directly by the client apps
- `@ordersail/storefront-sdk` published publicly on npm — any merchant (or their developer) can build a custom storefront against `storefront-api`, hosted on any domain
- Shared `ui` component package and Drizzle-based `db` schema package used across every app

## Architecture

An Nx-managed npm workspace monorepo.

| Path | What it is | Stack |
|---|---|---|
| `apps/merchant-api` | Merchant-facing REST API — auth, accounts, products, inventory, orders, Stripe Connect, API keys | NestJS (Fastify), Drizzle, JWT |
| `apps/merchant-web` | Merchant dashboard | React 19, TanStack Router/Query/Table, Tailwind |
| `apps/storefront-api` | Public REST API consumed by storefronts — products, cart, checkout | NestJS (Express), Drizzle, Stripe, Shippo |
| `apps/pos-api` | REST API for the POS app — device pairing, catalog, in-person orders | NestJS, Drizzle |
| `apps/pos` | Point-of-sale app — pairs to the account, builds orders, cash/card checkout | Expo / React Native |
| `apps/worker` | Background job consumer — order processing + transactional email; exposes `GET /health` only | NestJS, BullMQ |
| `apps/website` | Marketing site | Astro |
| `packages/db` | Shared Postgres schema & migrations (single source of truth for every API) | Drizzle ORM, Postgres 17 |
| `packages/merchant-sdk` / `storefront-sdk` / `pos-sdk` | Typed clients generated from each API's OpenAPI spec | openapi-typescript |
| `packages/queue` | Shared BullMQ queue names + job type definitions | BullMQ, ioredis |
| `packages/storage` | S3/MinIO client wrapper — presigned uploads, public-read bucket | AWS SDK v3 |
| `packages/email` / `email-templates` | Nodemailer transport + React Email templates | nodemailer, react-email |
| `packages/logging` | pino logger + correlation-ID context shared by the NestJS apps (see `docs/observability.md`) | pino |
| `packages/seed` | Local dev seed — demo "Sneaker Depot" catalog + images | tsx |
| `packages/ui` | Shared component library used by both React apps | React, Tailwind |

**Data model highlights** (`packages/db/src/schema`): `accounts` and `users` anchor multi-tenancy; `products` → `product_options`/`product_option_values` → `product_variants` model catalog variation; `categories` and `brands` classify products; `locations` + `inventory` + `inventory_movements` track stock with history; `carts`/`cart_items` are ephemeral pre-purchase state while `orders`/`order_items` are permanent, snapshotted records; `stripe_accounts` links an account to its Stripe Connect account (a missing row simply means "not connected yet"); `account_api_keys` scopes storefront API access per account.

`storefront-web` isn't in the table above — it's an external consumer of `storefront-api` in its own repo, not part of this workspace. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how it fits in the system map.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the full system map (service-to-service edges, queues, third-party calls)
- [docs/personas/](./docs/personas/README.md) — who we're building for: merchant owner, merchant staff, storefront shopper, POS cashier, storefront developer
- [docs/runbooks/](./docs/runbooks/) — operational runbooks (alerts, refunds/disputes, environment on/off, web checkout)

## Getting started

### Prerequisites

- **Node ≥ 22.12** and **npm 11** — the repo pins `npm@11.6.0` via `packageManager`,
  so `corepack enable` (or `npm i -g npm@11`) once, since Node 22 still ships npm 10.
- **Docker** with Compose v2 — for the local Postgres / Redis / MinIO / Mailpit stack.

### Quickstart

All commands run from the repo root.

```bash
npm ci
npm run setup       # .env from every .env.example — placeholder secrets, see "Secrets"
npm run up          # Postgres + Redis + MinIO + Mailpit (waits until healthy)
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
`npm run build` · `npm run typecheck` · `npm run push` / `npm run migrate` ·
`npm run seed`

Each NestJS API exposes Swagger/OpenAPI at runtime and has a `generate:openapi` script that regenerates `openapi.json`, which in turn feeds the corresponding SDK package.

## Deployment

AWS (ECS Fargate + CloudFront), provisioned with Terraform and shipped by GitHub
Actions (`.github/workflows/cd.yml`). See
[infra/terraform/README.md](./infra/terraform/README.md) for the layer layout,
the required repo/environment configuration, and the RDS / CloudFront runbooks.

## Roadmap

- Order history for customers (storefront-api has no customer-facing order-listing endpoint yet)
- Partial / line-item refunds (today's refund flow is full-order only)
- An explicit "fulfilled" order status (fulfillment is currently tracked via a permission, not a status transition)
- Tax handling beyond what Stripe Checkout quotes directly
- Storefront theming/templates on top of `@ordersail/storefront-sdk` (the SDK and multi-tenant CORS model are live; there's no themeable starter beyond `storefront-web` itself yet)
