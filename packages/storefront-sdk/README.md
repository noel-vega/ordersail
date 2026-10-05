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
  "https://storefront.ordersail.com",
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

`baseUrl` is the bare host. The API is versioned in its paths (every route
lives under `/v1`), and the SDK adds that prefix itself, so a given SDK
release always talks to the API version it was generated from.

### Upgrading from 0.7.x

**0.8.0 changes how errors arrive.** Every API error now has one body, and
`ApiError` carries it as typed fields: branch on `err.code` (see
[Error handling](#error-handling)) instead of `err.status` or the message.
Two behaviours change with it:

- The client refreshes the customer's token only on `invalid_access_token`.
  A bad app key or wrong credentials no longer trigger a refresh and retry.
- `ApiError`'s constructor changed. If you construct one yourself (in tests,
  say), pass `(message, status, body?)`.

0.7.x clients keep working against the new API, but every `ApiError.message`
is the generic `Request failed (<status>)`.

```bash
npm install @ordersail/storefront-sdk@^0.8.0
```

### Upgrading from 0.6.x

**0.7.0 is a breaking change.** storefront-api now serves every route under
`/v1`, so 0.6.x clients, which call unprefixed paths, get `404` on every
request. Upgrading is just the package bump; `baseUrl` stays the bare host
(don't append `/v1` yourself):

```bash
npm install @ordersail/storefront-sdk@^0.7.0
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

Every failed call throws `ApiError` (from `@ordersail/storefront-sdk`). Every
API error has the same shape, so one handler covers them all:

```ts
export class ApiError extends Error {
  readonly status: number; // the HTTP status
  readonly code: ApiErrorCode | undefined; // what to branch on, e.g. "email_taken"
  readonly type: ApiErrorType | undefined; // the broad category, e.g. "invalid_request_error"
  readonly message: string; // for people — show it, never parse it
  readonly param: string | undefined; // the request field at fault, when there is one
  readonly details: Record<string, unknown> | undefined; // data specific to the code
  readonly requestId: string | undefined; // quote this when reporting a problem
  readonly docUrl: string | undefined; // the code's reference page
}
```

**Branch on `code`, never on `message`.** Codes are part of the SDK's
contract; messages can be reworded at any time. `ApiErrorCode` is the union of
every code the API returns, and `isApiError` narrows a caught value:

```ts
import { isApiError } from "@ordersail/storefront-sdk";

try {
  await client.signUp(form);
} catch (err) {
  if (isApiError(err, "email_taken")) {
    setFieldError(err.param ?? "email", "That email already has an account.");
  } else if (isApiError(err, "validation_failed")) {
    // details.fields lists every failing field as { param, message }
    for (const { param, message } of err.details.fields) setFieldError(param, message);
  } else {
    throw err;
  }
}
```

A few codes worth knowing:

| Code | When |
|---|---|
| `invalid_app_key` | The `x-app-key` is missing, wrong or revoked. A configuration problem — fix the key. |
| `invalid_access_token` | The customer's access token is missing, expired or invalid. The client refreshes and retries this one for you. |
| `invalid_credentials` | `signIn` with a wrong email or password. |
| `email_taken` | `signUp` (or a profile update) with an email that already has an account. |
| `validation_failed` | A request field failed validation; `param` is the first, `details.fields` lists all. |
| `not_found` | The resource doesn't exist (single-resource reads return `undefined` instead). |
| `internal_error` | Something failed on OrderSail's side. The message is always generic; quote `requestId`. |

`code` is `undefined` only when the response carried no error body at all (a
proxy's or the network's error page); `message` is then
`` `Request failed (${status})` ``.

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
  "https://storefront.ordersail.com",
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

**Use one client per signed-in session.** A client restored from a refresh
token has no access token yet, so its first authenticated calls refresh
first. Calls on the _same_ client share that one refresh, so
`Promise.all([...])` is safe. Two _separate_ `StorefrontClient` instances
restored from the same stored token can't see each other's refresh, though:
each redeems the token, and the second redemption revokes the session. Create
one client for the session and share it (in the browser, a module-level
instance works) rather than one per component or request.

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
