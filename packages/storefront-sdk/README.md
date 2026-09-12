# @ordersail/storefront-sdk

A typed TypeScript client for OrderSail's public `storefront-api`. This is
the thing a merchant (or their developer) uses to build and host their
**own** storefront against OrderSail's catalog, cart, checkout, and customer
account data — `storefront-web` is just the worked reference example of
doing that.

Generated types come straight from `storefront-api`'s OpenAPI spec
(`src/types.gen.ts`); everything else is a thin, hand-written wrapper for
ergonomics around [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/).

## Install

This package isn't published yet — see the "Publishing" section of the
Storefront Builder Linear project for status. Once it is:

```bash
npm install @ordersail/storefront-sdk
```

Until then, inside this monorepo it's consumed via the npm workspace
protocol (see `apps/storefront-web/package.json`).

## Quickstart

```ts
import { StorefrontClient, ApiError } from "@ordersail/storefront-sdk";

const storefrontApi = new StorefrontClient(
  "https://api.your-storefront-api-host.com",
  "sfk_...", // your account's app key — see "Auth model" below
);

// reads return the data directly, or undefined if not found
const products = await storefrontApi.products.list({ limit: 20 });

// mutations throw a typed ApiError on failure
try {
  await storefrontApi.cart.addItem({ variantId: 123, quantity: 1 });
} catch (error) {
  if (error instanceof ApiError) {
    console.error(`${error.status}: ${error.message}`);
  }
}
```

## Resources

| Resource                      | Method                                  | Throws `ApiError`? |
| ------------------------------ | ---------------------------------------- | ------------------- |
| `storefrontApi.products`      | `list(query?)`                          | no                   |
|                                | `getById(id)`                           | no                   |
| `storefrontApi.cart`          | `get()`                                  | no                   |
|                                | `addItem(body)`                         | **yes**              |
|                                | `updateItem(variantId, body)`           | **yes**              |
|                                | `removeItem(variantId)`                 | **yes**              |
|                                | `clear()`                                | **yes**              |
| `storefrontApi.checkout`      | `getConfig()`                            | no                   |
|                                | `createSession(body)`                    | **yes**              |
|                                | `getSessionStatus(sessionId)`            | no                   |
|                                | `getShippingOptions(body)`               | no                   |
| `storefrontApi.customer`      | `get()`                                  | no                   |
|                                | `update(params)`                         | **yes**              |
| `storefrontApi` (top level)   | `signUp(dto)`                            | **yes**              |
|                                | `signIn(credentials)`                    | **yes**              |
|                                | `refreshAccessToken()`                   | no                   |
|                                | `logout()`                               | no                   |

The convention throughout: a read returns the response body directly (or
`undefined` on a non-2xx response), while a mutation throws `ApiError` so a
failure can't be silently ignored.

Not yet supported: **order history** for customers (`storefront-api` has no
customer-facing order endpoints yet — see Storefront Builder M5) and
**webhooks/real-time events** (no plans yet).

## Error handling

Every mutation throws `ApiError` (from `@ordersail/storefront-sdk`) on a
non-2xx response:

```ts
export class ApiError extends Error {
  readonly status: number; // the HTTP status code
  readonly message: string; // the server's message, when it sends one
}
```

`error.message` is the API's own message when the response body has one
(most validation and conflict errors do); otherwise it falls back to
`` `Request failed (${status})` ``. Two exceptions worth knowing: `signIn`'s
`401` and `signUp`'s `409` currently carry no response body at all, so
`error.message` for those two is always the generic fallback — write your
own copy for those cases rather than surfacing it (see
`apps/storefront-web/src/routes/signin.tsx` for the pattern).

## Auth model

Two independent layers, both handled for you by `StorefrontClient`:

- **Tenant scoping** — every request carries an `x-app-key` header (your
  account's app key, created in `merchant-web` under Settings → Developer
  API keys). Set once in the constructor; re-assign `client.appKey` later if
  you ever need to switch accounts.
- **Customer auth** — a bearer JWT (`accessToken`), held in memory only (it
  doesn't survive a page reload), plus an httpOnly `customer_refresh_token`
  cookie the browser sends automatically (`credentials: "include"`). Call
  `refreshAccessToken()` on app start to restore a session from that cookie.

**Known gap**: only `customer.get()`/`customer.update()` currently retry
once on a `401` by calling `refreshAccessToken()` and re-issuing the
request. `cart` and `checkout` methods do not — if you're calling them a
long time after the last customer request, a stale in-memory token can
produce an unhandled `401`. Call `refreshAccessToken()` proactively if this
matters for your integration, or treat it as a signed-out state and prompt
sign-in again.

## Regenerating after an API change

```bash
npm run generate:openapi -w storefront-api   # refresh storefront-api's openapi.json
npm run generate -w @ordersail/storefront-sdk  # regenerate types.gen.ts from it
```

Both steps are manual and their output is committed — there's no watch mode
or CI auto-regen.
