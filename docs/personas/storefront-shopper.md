# Storefront Shopper

The end customer buying from a merchant's storefront — `storefront-web` as shipped, or any custom storefront a merchant's developer builds against `storefront-api`/`@ordersail/storefront-sdk`. They never see `merchant-web`, never know an "account" (in Ordersail's multi-tenant sense) exists, and never interact with Ordersail as a brand — as far as they're concerned they're just buying sneakers from Priya's store.

## Who they are

- `order_actor_type = "customer"` on any order event they cause; their orders carry `order_channel = "web"` (as opposed to `"pos"` for in-person sales).
- Two independent identities layer on every request: a **cart token** (`x-cart-token`, anonymous, always present) and an optional **customer session** (bearer access/refresh token from `signUp`/`signIn`). Cart and checkout flow entirely through the cart token — a shopper can add to cart and check out without ever creating an account.
- Customer accounts are real and shipped (`signUp`/`signIn`/`customer.get`/`customer.update`, implemented in the reference [`storefront-web`](https://github.com/noel-vega/storefront-web) app's signup/signin/account pages) — newer than the guest-only model the root README's roadmap used to describe.

## Goals

- Find a product, understand what it costs including shipping, and pay — as few steps and as little friction as possible.
- Optionally, keep a profile (name/email) for next time, without being forced through account creation just to buy something once.
- Trust that checkout is safe: payment runs through Stripe's embedded checkout form (rendered directly by Stripe's JS in the storefront, browser-to-Stripe), not a form Ordersail or the merchant ever sees raw card data through.

## Surfaces used

- The reference **`storefront-web`** app (its own repo, [github.com/noel-vega/storefront-web](https://github.com/noel-vega/storefront-web)) or any merchant-custom storefront built on **`@ordersail/storefront-sdk`** → **`storefront-api`**.
- Never touches `merchant-web`, `merchant-api`, or any RBAC/permission surface — those are entirely invisible to this persona.

## What they can/can't do today

- Browse products, add/update/remove cart items, and see live shipping-rate options at checkout (an embedded Stripe Checkout Session with real Shippo-quoted rates).
- Sign up / sign in and edit their own profile (`customer.update`) — but **no order history view yet**: `storefront-api` has no customer-facing order-listing endpoint (explicitly deferred to Storefront Builder M5 per `packages/storefront-sdk/README.md`). A returning signed-in customer can check out faster but can't yet look back at what they bought.
- Land on a checkout-return page after paying, driven by the order's resolved status rather than a raw redirect assumption.

## Pain points

- No order history means "did my order go through / where's my tracking number" has to come from the checkout-return page or a support email to the merchant — there's no self-serve "my orders" page yet.
- Because a storefront can be merchant-custom and hosted on any domain, and browser cookies don't ride along cross-site, a signed-in session only survives a page reload if *that specific storefront's frontend* bothered to persist the refresh token (e.g. `localStorage`) — a corner-cut storefront implementation can silently log shoppers out on every refresh even though the SDK supports persisting sessions correctly.
- Guest checkout and signed-in checkout are two independent identity systems (cart token vs. customer token) — a shopper who signs in *after* building a guest cart isn't automatically the "owner" of that cart in any account-linked sense; the two don't merge today.

## A day in the life

Jamie finds Priya's sneaker store from an Instagram link straight to a product page on her storefront. No account, no login wall — they add a pair to their cart (identified purely by an anonymous cart token in a cookie), go to checkout, see real shipping cost quoted for their address before paying, and pay via Stripe's embedded checkout form. They land on the return page and see their order confirmed. A week later they're back for a restock; this time they create an account first so they don't have to re-type their address, sign in, and check out again — faster, but if they wanted to check on that first order's shipping status, there's nowhere in the storefront to look; they'd have to email the store directly.
