# POS Cashier

In-person staff ringing up sales on a merchant's shop floor, using the Ordersail POS app on a paired device. Web and in-person sales deliberately share one `orders` model — a cashier's sale and a storefront shopper's checkout end up as the same kind of row, distinguished only by `channel`.

## Who they are

- Their sales carry `order_channel = "pos"` and `order_payment_method` of `"cash"` or `"card"` (as opposed to `"stripe"` for web checkout) — `packages/db/src/schema/orders.ts`.
- Not authenticated as an individual user the way merchant-web staff are — the identity that matters here is the **device**, not the person standing at it. A device is paired once via a pairing code minted from `merchant-web`/`merchant-api` (`POST /pos-devices`, gated by `pos_devices:write`), redeems it via `POST /pos/pair`, and gets a long-lived `x-pos-device-token` that resolves to an account **and a specific location** — every subsequent request is scoped to that one location's stock (`apps/pos-api/README.md`).
- Whoever is physically behind the register on a given shift is this persona — the same device may be used by different staff across shifts without re-authenticating per person.

## Goals

- Ring up a sale fast: scan or search a product, take payment (cash or card), done — no friction that a shopper standing at the counter would notice.
- Trust that what the register says is in stock is actually in stock at *this* location, not some other location or a merged total.

## Surfaces used

- **`pos`** (Expo/React Native app) talking to **`pos-api`** — a fully separate API from `merchant-api`/`storefront-api`, "one API per client audience" by design, with its own Drizzle-backed read models and no backend-to-backend HTTP calls.
- Never touches `merchant-web` directly — device pairing/management is done by a Merchant Staff member with `pos_devices:write` from the dashboard, not by the cashier.

## What the device can do

- `GET /pos/catalog` — keyset-paginated active products with variants, price, per-location stock, images, SKU, barcodes.
- `GET /pos/catalog/scan?code=` — resolve a scanned barcode or typed SKU straight to a product/variant.
- `GET /pos/session` — confirm which account/location/device the token is bound to (useful for "which store am I even logged into" sanity checks).
- Build an order and take a cash or card payment — no Stripe Checkout Session involved for in-person tenders.

## Pain points

- Because the device token (not a per-person login) is the identity, there's no built-in accountability for *which employee* rang up a given in-person sale beyond whoever had the paired device — that granularity would need a separate per-cashier identity layer that doesn't exist today.
- Pairing is a one-time, Owner/Staff-initiated flow — if a device is lost or a code is mis-typed, recovery means a `pos_devices:write` holder revoking and re-issuing from `merchant-web`, not something the cashier can self-serve.
- Stock is reported for the device's bound location only — a cashier can't see or sell against another location's stock from the same register, by design, but it means a "we're out here, do we have it at the other store" question has to go through someone with dashboard access.

## A day in the life

At the start of her shift, Alicia picks up the store's paired tablet — already set up weeks ago, no login needed. A customer walks in wanting a specific sneaker in a size; Alicia searches the catalog on the POS app, finds it's in stock at this location, and scans the shoebox barcode to pull it up instantly rather than typing the SKU. The customer pays cash. The sale becomes an order with `channel: "pos"`, `method: "cash"` — no Stripe involved, no shipping address, just a completed in-person sale that shows up in Priya's order list next to her online orders, distinguishable only by its channel badge. At close, if the tablet needs to be swapped for a new one, that's not Alicia's job — she'd flag it to Priya, who revokes the old device and pairs a new one from Settings → POS Devices.
