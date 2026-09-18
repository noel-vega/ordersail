# merchant-api architecture

merchant-api is a **modular monolith**: one deployable NestJS app, internally
split into **bounded contexts** with enforced boundaries. See Linear milestone
*M8 — Modular monolith* for the why (we deliberately did **not** split it into
services — one shared Postgres, `dashboard` cross-joins domains, pre-launch).

## Contexts

`src/` is 6 domain contexts + a shared kernel. Every folder directly under
`src/` is a context (or `shared/`); root files (`src/*.ts`) are the composition
root.

<!-- table lists are the primary tables per context; OS-344 makes ownership
     precise via per-domain `db/<domain>` entrypoints -->

| Context | `src/` folder | Modules | Owns (schema tables) |
|---|---|---|---|
| **identity** | `identity/` | auth, users, roles, permissions, api-keys, account | `accounts`, `users`, `user_invites`, `account_api_keys`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_passkeys`, `webauthn_challenges` |
| **catalog** | `catalog/` | products, brands, categories | `products`, `brands`, `categories`, `product_options`, `product_option_values`, `product_variants`, `variant_option_values`, `product_categories`, `product_images`, `product_barcodes` |
| **stock** | `stock/` | inventory, locations | `locations`, `inventory`, `inventory_movements` |
| **sales** | `sales/` | orders, fulfillments, carts, customers, checkout-orders | `orders`, `order_shipping`, `order_payments`, `order_items`, `fulfillments`, `fulfillment_items`, `carts`, `cart_items`, `customers` |
| **payments** | `payments/` (flat) | stripe-connect, stripe-webhook | `stripe_accounts` |
| **platform** | `platform/` | dashboard, health, pos-devices | `pos_devices` |

**Shared kernel** — `src/shared/`. Pure cross-cutting infra, importable from
anywhere, **no domain logic**:
`common/` (utils), `database/` (the `DRIZZLE` provider, `@Global`),
`storage/` (S3/MinIO, `@Global`), `email/` (BullMQ enqueue, `@Global`),
`events/` (in-process domain-event bus + the event registry, `@Global` — see
*Cross-context communication*),
`auth/decorators.ts` (`@CurrentUser` / `@Public` / `@RequirePermissions` + the
request-context types — the guards themselves live in `identity/auth` and run
globally via `APP_GUARD`), `env.ts`.

## Rules (enforced by `eslint-plugin-boundaries` — see `eslint.config.mjs`)

1. A context imports **its own files** freely, plus the **shared kernel**.
2. A context reaches **another context only through that context's `index.ts`
   barrel** — never a deep path. The barrel is the context's public surface;
   everything else is internal.
3. Allowed cross-context edges:

   | From | May depend on |
   |---|---|
   | `identity` | — (shared only) |
   | `catalog` | `identity` |
   | `stock` | `identity` |
   | `payments` | `identity` |
   | `sales` | `identity`, `catalog`, `stock`, `payments` (refunds — via `sales/orders/ports/`) |
   | `platform` | `identity`, `sales` — **`platform/dashboard` is the one cross-context read-model**, allowed to query other contexts' data for summary views |

4. The shared kernel is a **leaf** — it may not import a context.

Adding a new cross-context edge = update the table above **and** the
`boundaries/dependencies` policies in `eslint.config.mjs` (they must agree).

## Cross-context communication

- **Adapter behind a local port** — the pattern for calling another context's
  services. The consumer defines a port interface; an adapter class in the
  consumer's `ports/` folder implements it by delegating to the producer's
  barrel-exported services. The consumer's domain code depends only on the port.
  Extraction = swap the adapter for an HTTP client, nothing else changes.

  Two live edges:
  - **`platform/dashboard → sales`**. `dashboard.service` depends on `SalesPort`
    (`platform/dashboard/ports/sales.port.ts`); `SalesAdapter`
    (`…/ports/sales.adapter.ts`) is the *only* file in `platform/` that imports
    `sales`' services — enforced by `no-restricted-imports` in
    `eslint.config.mjs`. `dashboard.service`'s `getOrderTotals` /
    `getOutOfStockCount` stay as direct SQL (deliberate read-model projections —
    platform is exempt from the read-graph).
  - **`sales → payments`** (M2 refunds, OS-121). `sales` owns the order
    lifecycle; `payments` owns the Connect mapping (`stripe_accounts`) and the
    Stripe surface. `RefundsService` (`sales/orders/`) depends on `PaymentsPort`
    (`sales/orders/ports/payments.port.ts`) with one method, `refundPaymentIntent`;
    `PaymentsAdapter` (`…/ports/payments.adapter.ts`) is the only file in `sales`
    that imports `src/payments`, delegating to `StripeRefundsService`. Chosen over
    a direct `sales → payments` service call (the OS-359 decision point): `payments`
    is extraction seam #1, and the adapter keeps that cut a one-file change.
    Status transitions + the negative-payment / restock writes stay entirely in
    `sales` (`transitionOrderStatus` / `recordRefund`); `payments` only talks to
    Stripe.
- **Domain events** — for a genuine reactive side-effect in another context,
  not a synchronous read (use a port for that). In-process, via
  `@nestjs/event-emitter`, wired by the `shared/events` kernel module.

  The registry lives in `src/shared/events/events.ts`: a `DOMAIN_EVENTS` name
  constant + a `DomainEventMap` entry (payload type) per event. Payload types
  live in the shared kernel because producer and consumer both depend on them
  and neither context owns them. Consumer: a provider method decorated
  `@OnDomainEvent(DOMAIN_EVENTS.X)` with its parameter typed `DomainEventMap['x']`.
  Producer: inject `DomainEventBus` and call one of —
  - **`emit(name, payload)`** — fire-and-forget, in-process, on the emitting
    call stack. The emitter doesn't wait for handlers and never sees their
    errors (a rejected async handler is an unhandledRejection). For non-critical
    reactions; such a handler must catch its own errors.
  - **`await emitAsync(name, payload)`** — awaits every handler and rejects if
    any of them rejects. Use when the emitter must not report success until the
    reaction durably happened — e.g. the checkout webhook returns non-2xx (and
    Stripe retries) if `sales` couldn't enqueue the order.

  Neither is **durable** — a process crash between emit and handler loses the
  event. A handler doing durable work does it within the emitting request's
  lifetime and tolerates a retry (enqueues a BullMQ job whose consumer is
  idempotent). An event does not cross the boundary lint (`payments` never
  imports `sales`); only `shared/events` is shared.

  Live events: **`checkout.session.paid`** — `payments/stripe-webhook.controller`
  (the one Stripe webhook endpoint) verifies + emits it; `sales/checkout-orders`
  resolves the cart into an order-job payload and enqueues it on the `orders`
  queue (owned here — `apps/worker` consumes it and writes the order). See M9.
- The shared kernel — for pure infra only.

## Write model — plain services, not CQRS (OS-359)

M9 (`checkout.session.paid` handoff) chose `@nestjs/event-emitter` over
`@nestjs/cqrs`; M2 (OS-359) re-evaluated that with the order-lifecycle write
model — status transitions, refunds, cancel — actually in hand.

**Decision: stay on plain NestJS services.** The M2 flows
(`RefundsService.refundOrder`, `CancelService.cancelOrder`) are each *one*
guarded method: an external call (Stripe) followed by a *single* DB transaction
composed from small executor-taking helpers (`transitionOrderStatus`,
`recordRefund` / `applyRestock` / `resolveRestockTargets` in
`sales/orders/`). Their failure mode — Stripe succeeded, the commit didn't — is
handled by an **idempotency key + the `charge.refunded` webhook reconciliation**
(OS-127), not by an in-process compensating saga.

`@nestjs/cqrs`'s value is command routing and long-running process managers
(Sagas). Neither applies here: there's one caller per operation and no
multi-step orchestration to manage. The `CommandBus` / `@CommandHandler` /
`@Saga` ceremony would wrap a linear method without buying anything. Revisit if
a genuine multi-transaction process manager appears (e.g. a returns/RMA flow
that spans customer action → inspection → restock → refund over days).

## Data access (read-graph)

One Postgres, one Drizzle schema (`packages/db`), **cross-domain FKs kept** (real
integrity; `dashboard` needs the joins).

`packages/db` exposes a **per-domain entrypoint** per context —
`db/identity`, `db/catalog`, `db/stock`, `db/sales`, `db/payments` — each
re-exporting that domain's schema tables + the drizzle query helpers. Root `db`
stays the full export (for `platform/dashboard`, `drizzle-kit`, and the other
apps).

A context imports **its own `db/<domain>`** plus the entrypoints on its
**read-graph**. Root `db` and `db/schema` are blocked in every context.
Enforced by `no-restricted-imports` in `eslint.config.mjs` (the `denied` map
there must agree with this table).

| Context | may import `db/…` |
|---|---|
| `identity` | `identity`, `stock`¹ |
| `catalog` | `catalog`, `stock`² |
| `stock` | `stock`, `catalog`², `identity` |
| `sales` | `sales`, `catalog`, `stock`, `identity` |
| `payments` | `payments`, `identity` |
| `platform` | root `db` — exempt (`dashboard` read-model) |
| `shared` | root `db` only (the `DRIZZLE` provider); no schema |

**Known coupling — revisit later:**

- **² `catalog ↔ stock` cycle** — `catalog` reads stock levels for product
  listings; `stock` reads product identity for inventory views. They change
  together. If it bites: merge the two contexts, or break the reads through
  service ports (OS-345 pattern).
- **¹ `identity → stock`** — signup (`auth.service`) seeds the new tenant's
  default `locations` row in the same transaction as the account. A provisioning
  *write*, not a read. Revisit via an `account.created` domain event so `stock`
  owns it.

Reads still cross **only** these edges; a genuine service call between contexts
goes through the barrel (see *Cross-context communication*), not raw table
access.

## Extraction seams (if we ever split a context into its own service)

Ordered by how clean the cut is:

1. **`payments`** — `stripe-connect` + `stripe-webhook` (the one Stripe webhook
   endpoint), owns only `stripe_accounts`, depends on `identity` alone (its only
   link to `sales` is the `checkout.session.paid` event, not an import). The
   Stripe surface is also used by storefront-api / worker → `packages/payments`
   (OS-347) is the shared core. Cut: `stripe_accounts.accountId → accounts.id` FK
   becomes a soft reference.
2. **`sales` + fulfillment** — larger, but a natural service boundary (order
   lifecycle). Owns the `orders` BullMQ producer (`checkout-orders`);
   `apps/worker` is the consumer. Cuts: `order_items.variantId →
   product_variants.id`, `inventory_movements.orderItemId → order_items.id`,
   `order_shipping.locationId → locations.id` become soft references; the
   `dashboard` read-model moves to a query API or a projection.

At each seam: the in-process adapter (OS-345 pattern) becomes an HTTP client, and
the FKs listed above are dropped in favor of application-level references.

## Resilience / blast radius

merchant-api is one process — a fault in one context can take **all** contexts
down. What keeps that bounded (OS-346 audit):

- **Every external SDK client sets a timeout.** Redis: `commandTimeout: 5_000`
  (`app.module.ts` via `createRedisConnection`). Stripe:
  `timeout: 20_000, maxNetworkRetries: 1` (the `STRIPE` provider in
  `payments/payments.module.ts`, via `packages/payments` — the SDK default is
  80 s). Shippo: `timeoutMs: 20_000`
  (`sales/fulfillments/shippo.client.ts`). S3: `requestTimeout: 10_000`
  (`packages/storage`). **Add a timeout to any new client.**
- **Webhooks fail as 4xx, not 5xx, on bad input** — `payments/stripe-webhook.controller.ts`
  (the one endpoint, dispatching `account.updated` + `checkout.session.*` by type)
  uses `constructWebhookEvent` from `packages/payments`, which turns a bad/missing
  signature into a `BadRequestException` so Stripe stops retrying. A *processing*
  failure (checkout branch → `sales` can't enqueue) is deliberately a 5xx so Stripe
  **does** retry — a paid order must not be lost.
- **No unbounded in-process work** — no module-level mutable caches,
  `setInterval`, `while(true)`, or unbounded recursion. `onModuleInit` hooks
  either fail-fast (`permissions` — don't serve without the catalog) or are
  wrapped (`storage`).
- **List endpoints must paginate.** `sales/orders` is the reference
  (`PaginatedOrders` + `@Query('limit', DefaultValuePipe, ParseIntPipe)`).
  Still unbounded, tracked: `GET /inventory/movements` (OS-349, append-only
  ledger) and `GET /products` `/inventory` `/customers` (OS-350).

Not here: expand/contract migrations (deploy ≠ migration coupling) and canary
deploys — those live in *Production readiness*.

## Not here

- **Nx libraries** (contexts as `packages/merchant-<context>/` +
  `@nx/enforce-module-boundaries`) — the known next step, tracked as OS-348. Do
  it when `nx affected` would save real CI time or a second person owns a
  context.
