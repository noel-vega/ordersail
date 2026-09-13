# Merchant Owner

The person who signed up for the Ordersail account. Every account gets exactly one non-deletable, non-editable `Owner` role, seeded at signup and always holding every permission in the catalog — they are the account's root user, not just its first employee.

## Who they are

- Maps to the `Owner` role: `roles.isSystem = true`, created by `createSystemRole` (`apps/merchant-api/src/identity/roles/roles.service.ts`). The service explicitly refuses to edit (`ForbiddenException('The Owner role cannot be edited')`) or delete it, and re-tops it up with any newly shipped permission on every boot (`backfillSystemRoles`) so it never drifts out of sync with the catalog.
- Unlike every other role, `Owner` is the *only* role allowed to hold all 30 permission keys — a custom role is explicitly blocked from doing that (`"A custom role cannot hold every permission — assign the Owner role instead"`).
- Often the actual owner/founder of the retail business, not a technical user — signup is self-serve, no sales call or manual provisioning.

## Goals

- Get the store live: create the account, catalog the first products, connect a Stripe account, and start taking orders with as little friction as possible.
- Delegate day-to-day work without giving away the keys — invite staff and shape what each of them can touch.
- Trust that money is safe: Ordersail never holds merchant funds (Stripe Connect Express), so the Owner's core financial anxiety is "is my Stripe account connected and healthy," not "does Ordersail have my money."

## Surfaces used

- **`merchant-web`** — the only surface this persona uses directly. Everything below (roles, Stripe Connect, API keys, storefront origins) is a `merchant-web` screen backed by `merchant-api`.
- Never touches `storefront-web`, `pos`, or the SDKs directly — those are what the Owner *configures access to* for others (customers, cashiers, developers), not what they personally operate.

## Permissions

All 30 keys, unconditionally — `roles:*`, `users:*` (including `manage_roles` and `deactivate`), `customers:*`, `orders:*` (including `refund`/`cancel`), `fulfillments:write`, `products:*`, `inventory:*`, `locations:*`, `api_keys:*`, `storefront_origins:*`, `pos_devices:*`, `payments:*`, `account:*`. There is no scenario in the product where an Owner is blocked from an action a custom role can perform.

## Pain points

- The role/permission UI is real and enforced, but there are no pre-built role templates yet — the Owner has to reason correctly about a 30-key permission catalog from scratch when building a custom role for the first hire.
- Stripe Connect onboarding is a real external flow (embedded Connect components, `charges_enabled`/`details_submitted` polling) — the Owner can get "stuck" mid-onboarding on Stripe's side, and the dashboard's job is to make that state legible rather than a spinner.
- If they want a storefront that isn't the reference [`storefront-web`](https://github.com/noel-vega/storefront-web) app as-is (custom design, different framework), they either have to become the Storefront Developer persona themselves or hand this doc + `packages/storefront-sdk/README.md` to whoever they hire to do it.

## A day in the life

Priya runs a two-location sneaker resale business and just heard about Ordersail from a friend. She signs up, which creates her account and her user in one step — she's automatically the `Owner`. First thing in `merchant-web`, she goes to Settings → Payments and clicks through Stripe Connect onboarding (embedded components, no redirect to a separate Stripe-hosted page) to link her existing Stripe account; she comes back to the dashboard and watches the connect-status badge flip from "action needed" to "connected" once Stripe reports `charges_enabled: true`.

Next she adds her two store locations, then imports her catalog — products with Size/Color options, generating variants automatically — and sets opening stock per location, which writes the very first entries into the inventory movement ledger. She invites her first hire, a part-time fulfillment person, and instead of making them another Owner, she goes to Settings → Roles, creates a "Fulfillment" role scoped to `orders:read`, `orders:write`, `fulfillments:write`, and `inventory:read`/`write`, and assigns it — deliberately withholding `orders:refund`, `payments:*`, and `account:*` so a part-timer can pack and ship orders but can't touch her Stripe connection or issue refunds. Finally she mints a storefront API key under Settings → Developer API keys, registers the contractor's domain under storefront origins for CORS, and hands both to the contractor building her public storefront — whether that's a clone of the reference `storefront-web` app or their own frontend, both consume `@ordersail/storefront-sdk` the same way.
