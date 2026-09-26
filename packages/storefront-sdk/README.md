# @ordersail/storefront-sdk

A typed TypeScript client for OrderSail's public `storefront-api`. This is
the thing a merchant (or their developer) uses to build and host their
**own** storefront against OrderSail's catalog, cart, checkout, and customer
account data — [`storefront-web`](https://github.com/noel-vega/storefront-web)
is just the worked reference example of doing that, in its own public repo.

Generated types come straight from `storefront-api`'s OpenAPI spec
(`src/types.gen.ts`); everything else is a thin, hand-written wrapper for
ergonomics around [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/).

## Install

```bash
npm install @ordersail/storefront-sdk
```

Inside this monorepo it's consumed via the npm workspace protocol instead
(see the consumer-contract spec, `apps/storefront-api/src/contract/storefront-sdk.contract.spec.ts`).

## Quickstart

```ts
import { StorefrontClient, ApiError } from "@ordersail/storefront-sdk";

const storefront = new StorefrontClient(
  "https://api.your-storefront-api-host.com",
  "sfk_...", // your account's app key — see "Auth model" below
);

const products = await storefront.products.list({ limit: 20 });

try {
  await storefront.cart.addItem({ variantId: 123, quantity: 1 });
} catch (error) {
  if (error instanceof ApiError) {
    console.error(`${error.status}: ${error.message}`);
  }
}
```

## Resources

| Resource                 | Method                        | Throws `ApiError`? |
| ------------------------ | ----------------------------- | ------------------ |
| `storefront.products`    | `list(query?)`                | **yes**            |
|                          | `getById(id)`                 | only unexpectedly¹ |
| `storefront.cart`        | `get()`                       | only unexpectedly¹ |
|                          | `addItem(body)`               | **yes**            |
|                          | `updateItem(variantId, body)` | **yes**            |
|                          | `removeItem(variantId)`       | **yes**            |
|                          | `clear()`                     | **yes**            |
| `storefront.checkout`    | `getConfig()`                 | **yes**            |
|                          | `createSession(body)`         | **yes**            |
|                          | `getSessionStatus(sessionId)` | only unexpectedly¹ |
|                          | `getShippingOptions(body)`    | **yes**            |
| `storefront.customer`    | `get()`                       | only unexpectedly² |
|                          | `update(params)`              | **yes**            |
|                          | `orders.list(query?)`         | **yes**            |
|                          | `orders.getById(id)`          | only unexpectedly¹ |
| `storefront` (top level) | `signUp(dto)`                 | **yes**            |
|                          | `signIn(credentials)`         | **yes**            |
|                          | `refreshAccessToken()`        | only unexpectedly² |
|                          | `logout()`                    | no                 |

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
own copy for those cases rather than surfacing it.

## Auth model

Two independent layers, both handled for you by `StorefrontClient`:

- **Tenant scoping** — every request carries an `x-app-key` header (your
  account's app key, created in `merchant-web` under Settings → Developer
  API keys). Set once in the constructor; re-assign `client.appKey` later if
  you ever need to switch accounts.
- **Customer auth** — a bearer access token and a refresh token, both
  returned in the response body by `signUp()`/`signIn()` and held on
  `client.accessToken`/`client.refreshToken`.

The refresh token is **single-use**: every `refreshAccessToken()` call
rotates it — the response carries a _new_ refresh token alongside the new
access token, and the one you presented stops working immediately.
Presenting an already-used (rotated-out) refresh token again isn't just
rejected — the server treats that as a sign the token was copied or stolen
and revokes the customer's _entire_ session, so even a different,
still-unused refresh token from the same login is dead afterward too. In
practice this means you can't read `client.refreshToken` once after
`signIn()` and keep reusing that same string — you need to track whichever
value is _current_ the whole time a session is alive.

Do that with the `onTokensChanged` constructor option, called after every
`signUp()`/`signIn()`/`refreshAccessToken()`/`logout()` with the tokens'
current values — this is the mechanism to persist a session across a page
reload, not `client.refreshToken` read once:

```ts
const storefront = new StorefrontClient(
  "https://api.your-storefront-api-host.com",
  "sfk_...",
  undefined, // cartToken — restore the same way if you have one saved
  localStorage.getItem("refreshToken") ?? undefined,
  {
    onTokensChanged: ({ refreshToken }) => {
      if (refreshToken) localStorage.setItem("refreshToken", refreshToken);
      else localStorage.removeItem("refreshToken");
    },
  },
);

// on app start, if a refreshToken was restored above:
await storefront.refreshAccessToken();
```

Neither token is persisted by the SDK itself: a storefront can be hosted on
any merchant-owned domain, and a cookie set by `storefront-api` never rides
along on a genuinely cross-site request, so there's no cookie to rely on —
`onTokensChanged` is the mechanism instead.

`logout()` is `async` and does two things: clears `accessToken`/`refreshToken`
locally — synchronously, before any network call, so they're already gone
even if you don't `await` the returned promise — and makes a best-effort
call to revoke the session server-side too. A failed network call there
still leaves you logged out locally; it just means the now-orphaned refresh
token stays valid until it expires on its own instead of being revoked
immediately.

Only `customer.get()`/`customer.update()`/`customer.orders.*` retry once on a `401` by calling
`refreshAccessToken()` and re-issuing the request — `cart` and `checkout`
methods don't, and don't need to: they never check the customer JWT at all.
Cart/checkout identity flows entirely through the `x-cart-token` header
(guest checkout is fully supported), so the only thing that can produce a
401 there is a missing/invalid/revoked `x-app-key` — an entirely different
credential that refreshing the customer's access token can't fix.

## Regenerating after an API change

```bash
npm run generate:openapi -w storefront-api   # refresh storefront-api's openapi.json
npm run generate -w @ordersail/storefront-sdk  # regenerate types.gen.ts from it
```

Both steps are manual and their output is committed — there's no watch mode
or CI auto-regen.
