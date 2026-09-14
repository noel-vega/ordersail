# User personas

Ordersail serves several distinct people, not one generic "user." This folder is the shared reference for who they are, what they're trying to get done, and which surface of the platform they actually touch — so that feature and RBAC decisions have a concrete answer to "who is this for" instead of an assumed one.

Each persona is grounded in the real system: actual RBAC roles/permissions (`packages/db/src/permissions-catalog.ts`), the real `order_channel`/`order_actor_type` enums (`packages/db/src/schema/orders.ts`), and the real app boundaries (`apps/*`). None of these are invented UX-research archetypes — where the doc says a role or endpoint exists, it exists in code today.

- [Merchant Owner](./merchant-owner.md) — the account's one fixed, all-permissions system role. Signs up, connects Stripe, brings the account live.
- [Merchant Staff](./merchant-staff.md) — account-defined custom roles built from the 28-key permission catalog. Runs the day-to-day: fulfillment, support, catalog upkeep.
- [Storefront Shopper](./storefront-shopper.md) — the end customer buying on a storefront. Guest checkout today, account-based checkout landing with Storefront Builder M2.
- [POS Cashier](./pos-cashier.md) — in-person staff ringing up sales on a paired POS device at a specific location.
- [Storefront Developer](./storefront-developer.md) — the merchant or third-party developer building a storefront against `@ordersail/storefront-sdk` and `storefront-api`, rather than using `storefront-web` as-is.

## Keeping this current

Update the relevant file whenever a change actually shifts what one of these personas can do or how they do it — a new permission key, a new endpoint they call, a UI flow that replaces an old one. A persona doc that describes a screen or endpoint that no longer exists is worse than no doc; treat drift here the same as drift in `ARCHITECTURE.md`.
