# Architecture

This is a system-level map of Ordersail: the apps, the shared packages, and the infra/third-party
services they depend on. It's generated from the current state of the code (including
in-flight, uncommitted work), not just what's in the [README](./README.md)'s architecture
table — notably `worker`, `queue`, `email`, `email-templates`, and `storage` aren't in that
table yet.

## System map

```mermaid
flowchart TB
    subgraph FE["Frontends"]
        website["website<br/>Astro · :4321<br/><i>marketing, standalone</i>"]
        adminweb["merchant-web<br/>React 19 + Vite · :5000<br/><i>merchant dashboard</i>"]
    end

    subgraph EXTFE["External (own repo, not deployed by this platform)"]
        storeweb["storefront-web<br/>Next.js<br/><i>reference customer storefront —<br/>github.com/noel-vega/storefront-web</i>"]
    end

    subgraph SDK["Generated SDKs"]
        adminsdk["merchant-sdk<br/><i>openapi-fetch, typed</i>"]
        storesdk["storefront-sdk<br/><i>openapi-fetch, typed</i>"]
    end

    subgraph API["APIs"]
        adminapi["merchant-api<br/>NestJS/Fastify · :3000<br/><i>products, inventory, orders,<br/>staff, Stripe Connect</i>"]
        storeapi["storefront-api<br/>NestJS/Express · :3001<br/><i>cart, checkout, customers</i>"]
    end

    worker["worker<br/>NestJS · :3003<br/><i>BullMQ consumer:<br/>orders + email queues</i>"]

    subgraph PKG["Shared workspace packages"]
        db["db<br/><i>Drizzle schema</i>"]
        queue["queue<br/><i>BullMQ names/job types</i>"]
        email["email<br/><i>nodemailer transport</i>"]
        emailtpl["email-templates<br/><i>react-email components</i>"]
        storage["storage<br/><i>S3 client wrapper</i>"]
        ui["ui<br/><i>shared React components</i>"]
    end

    subgraph INFRA["Local infra (root docker-compose.yml)"]
        postgres[("Postgres 17")]
        redis[("Redis 7")]
        minio[("MinIO")]
        mailpit[("Mailpit<br/>(dev SMTP)")]
    end

    subgraph EXT["Third-party APIs"]
        stripe(["Stripe<br/>+ Connect"])
        shippo(["Shippo"])
    end

    adminweb --> adminsdk --> adminapi
    storeweb -. "npm install<br/>@ordersail/storefront-sdk" .-> storesdk
    storesdk --> storeapi
    adminweb -. "Stripe Connect JS<br/>(browser, direct)" .-> stripe
    storeweb -. "Stripe Embedded Checkout<br/>(browser, direct)" .-> stripe
    adminweb --> ui

    adminapi --> db
    storeapi --> db
    worker --> db
    db --> postgres

    adminapi -->|produces: email| queue
    storeapi -->|produces: orders, email| queue
    worker -->|consumes + produces| queue
    queue --> redis

    adminapi --> storage --> minio
    adminapi --> stripe
    adminapi --> shippo
    storeapi --> stripe
    storeapi --> shippo

    worker --> email --> mailpit
    worker --> emailtpl
```

**Notes**

- No backend-to-backend HTTP traffic — `merchant-api` and `storefront-api` never call each
  other. The only inter-service calls are frontend → its own API, via a generated SDK.
- All three backend services (`merchant-api`, `storefront-api`, `worker`) expose an unauthenticated
  `GET /health` (database + Redis checks, via `@nestjs/terminus`). It's why `worker` listens on
  `:3003` at all now — it has no user-facing API, just this liveness signal for whatever orchestrator
  ends up running it. `worker`'s check also verifies each queue's consumption loop is actually
  draining a backlog, not just that Redis is reachable — a plain Redis ping can't tell the two apart
  (see the worker-reconnect-stall note in memory).
- Logging, correlation IDs, and how to trace a request across API → queue → worker:
  see [`docs/observability.md`](docs/observability.md).
- `website` is fully standalone: no workspace deps, no outbound calls, static marketing content.
- Every account is a tenant with its own Stripe Connect account — `merchant-api` and
  `storefront-api` both call Stripe directly (Connect onboarding vs. Checkout Sessions
  respectively), and both browser apps also load Stripe's JS SDK directly for card entry —
  that's the one place a frontend talks to a third party without going through its own backend.
- `email` (SMTP transport) and `email-templates` (rendering) are only ever imported by `worker`.
  The two APIs only ever *enqueue* email jobs via `queue` — they never touch SMTP.

## Order + email job flow

The multi-step async path from a paid Stripe checkout to a sent confirmation email, across the
`orders` and `email` BullMQ queues:

```mermaid
sequenceDiagram
    participant Stripe
    participant storeapi as storefront-api
    participant redis as Redis (BullMQ)
    participant worker
    participant pg as Postgres
    participant mail as SMTP

    Stripe->>storeapi: checkout.session.completed webhook
    storeapi->>storeapi: validate session, resolve cart
    storeapi->>redis: enqueue "checkout-completed"<br/>(orders queue)
    redis->>worker: deliver job
    worker->>pg: insert order + items +<br/>inventory movements (tx)
    worker->>redis: enqueue "order-confirmation"<br/>(email queue)
    worker->>pg: set confirmationEmailQueuedAt
    redis->>worker: deliver "order-confirmation" job
    worker->>worker: render via email-templates<br/>(react-email → HTML string)
    worker->>mail: send via nodemailer
```

If `worker` dies between the order commit and the email enqueue, BullMQ's stalled-job
redelivery re-runs the job; the idempotency check on `stripeCheckoutSessionId` skips
re-creating the order but still retries the email (via the `confirmationEmailQueuedAt` flag)
rather than losing it silently.

The same `email` queue also takes two simpler, single-step jobs enqueued directly by the APIs
(no `orders` queue involved): `staff-invite` from `merchant-api` and `customer-thank-you`
from `storefront-api`, both consumed by the same `worker` email processor.
