# Storefront Developer

The person building a storefront frontend against Ordersail's public API — a merchant's contractor, an in-house engineer, or whoever works on the reference [`storefront-web`](https://github.com/noel-vega/storefront-web) app itself. `storefront-web` lives in its own public repo (a from-scratch Next.js app, not part of this monorepo) and is explicitly "the worked reference example," not the only allowed way to build one (`packages/storefront-sdk/README.md`) — it's built the exact same way any third-party storefront would be: an external consumer of `@ordersail/storefront-sdk`. This is the newest persona, tied directly to the Storefront Builder project's SDK-first model.

## Who they are

- Consumes `@ordersail/storefront-sdk`, a typed client generated from `storefront-api`'s OpenAPI spec, published on public npm (`npm install @ordersail/storefront-sdk`) via OIDC Trusted Publishing.
- Not a user in Ordersail's RBAC sense at all — they don't sign in to `merchant-web`. What they hold is a credential the Owner or a permissioned Merchant Staff member (`api_keys:write`) hands them: an account-scoped **app key** (`sfk_...`).
- Could be building anywhere: their own Next.js/Astro/whatever app, hosted on any domain — the whole model is designed around "storefronts hosted anywhere," not a single blessed frontend.

## Goals

- Stand up a working storefront (browse, cart, checkout, optionally customer accounts) without reverse-engineering `storefront-api` from scratch — the SDK's job is to make that a typed, ergonomic integration instead.
- Get clear, typed failures (`ApiError` with a real `status`) instead of guessing why a request failed.

## Surfaces used

- **`@ordersail/storefront-sdk`** → **`storefront-api`**. Never touches `merchant-web`/`merchant-api` except to obtain the two credentials below from someone who does.
- Regenerates the SDK locally after an API change via `npm run generate:openapi -w storefront-api` then `npm run generate -w @ordersail/storefront-sdk` — both manual, no watch mode or CI auto-regen.

## The credential that gates everything

**App key** (`x-app-key`, tenant scoping) — minted in `merchant-web` under Settings → Developer API keys, gated by `api_keys:write`. Identifies *which account's* catalog/cart/checkout this storefront talks to. Set once on `StorefrontClient`'s constructor. `storefront-api`'s CORS is permissive by design (storefronts can be hosted on any domain, and the app key is meant to be public like a Stripe publishable key) — there's no separate origin-registration step to forget.

On top of that, **customer auth** is a second, independent, optional layer — bearer access/refresh tokens from `signUp`/`signIn`, used only for `customer.get`/`customer.update`. Cart and checkout never check it; they run entirely on the `x-cart-token` header, so guest checkout works with zero customer-auth code at all.

## Pain points

- Two separate credential/identity concepts (app key, customer bearer token) that a developer has to keep straight — mixing up "because of a bad app key" vs. "because the customer session expired" is an easy trap.
- Nothing persists the customer session for you — a storefront that doesn't bother persisting `refreshToken` (e.g. to `localStorage`) will silently log every customer out on refresh; the SDK supports doing this correctly but doesn't force it.
- No order history endpoint yet (explicitly deferred to Storefront Builder M5) — a developer building a "my orders" page today has nothing in `storefront-api` to call.
- Two manual, uncommitted-automation regen steps (`generate:openapi` then `generate`) mean a storefront can silently drift against a newer `storefront-api` if a developer forgets to re-run them after pulling an API change.

## A day in the life

A contractor is hired to build a custom Next.js storefront for a merchant who doesn't want to run the reference `storefront-web` app as-is — the same relationship `storefront-web`'s own maintainers have to `storefront-api`, just in a different repo. Priya (the Owner) mints a new app key under Settings → Developer API keys and hands it to the contractor. The contractor runs `npm install @ordersail/storefront-sdk`, constructs a `StorefrontClient` with the app key, and builds product listing/cart/checkout pages — locally against `localhost`, everything works. They wire up `signUp`/`signIn` for optional customer accounts, persisting the refresh token to `localStorage` so a page reload doesn't log people out, and wrap every mutation in a check for `ApiError` to surface real messages instead of a generic failure screen. On deploy day, the production domain works immediately with the same app key — no separate registration step. Three months later `storefront-api` ships a new field on checkout sessions; the contractor re-runs the two `generate` commands, sees the new typed field show up in `types.gen.ts`, and updates their checkout page to use it.
