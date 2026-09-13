# Merchant Staff (custom roles)

Everyone on a merchant's team who isn't the Owner. There is no hardcoded "Manager"/"Staff"/"Admin" role in the schema — every non-Owner role is a custom, account-defined bundle of permissions picked from the same 30-key catalog the Owner has access to. "Merchant Staff" as a persona is really a family of personas that varies per account; the two illustrative sub-profiles below are the common shapes, not fixed system roles.

## Who they are

- A row in `roles` with `isSystem = false`, holding some subset of `PERMISSIONS_CATALOG` (`packages/db/src/permissions-catalog.ts`), assigned to one or more `users` via `user_roles`.
- Effective permissions are computed live from the DB on each request (`permissions.service.ts` deliberately doesn't cache this), so a permission change by the Owner takes effect immediately, not on next login.
- Enforced end-to-end: `@RequirePermissions` guards on the API side per domain, and `<Can>` / `usePermissions` gating nav and actions in `merchant-web`, with a `/app/403` page for anything a user's role doesn't cover.
- Can be soft-deactivated (`users.deactivatedAt`) rather than deleted, preserving their history on orders/events they touched while cutting off access.

## Goals

- Do their specific job (pack orders, answer a refund request, keep the catalog accurate) without needing to understand or touch anything outside it.
- Not get blocked by a missing permission mid-task, and not be confused when a nav item or button is invisible because their role doesn't grant it.

## Surfaces used

- **`merchant-web`**, same as the Owner — there's no separate "staff app." What differs is which nav items and actions render, driven by `usePermissions`/`<Can>` reading their effective permission set from `GET /auth/me`.
- May also be the person who pairs and manages POS devices (`pos_devices:write`) or configures storefront origins (`storefront_origins:write`) for the Storefront Developer, if their role includes those keys.

## Two illustrative example roles

**Fulfillment clerk** — `orders:read`, `orders:write`, `fulfillments:write`, `inventory:read`, `inventory:write`. Can see and update orders, mark them fulfilled, purchase shipping labels, and adjust stock — but has no `orders:refund`/`orders:cancel`, no `payments:*`, and no `users:*`, so they can't touch money or teammates.

**Support agent** — `orders:read`, `orders:refund`, `orders:cancel`, `customers:read`, `customers:write`. Can look up a customer's order and resolve a complaint end-to-end (refund or cancel) and update the customer's contact info, but can't edit products, adjust inventory, or see Stripe/payout status.

A single account might have both, plus a third role that mixes in `pos_devices:write` for whoever manages the shop floor's registers.

## Pain points

- Because roles are fully custom per account, a new hire's access is only as good as the Owner's role design — a poorly scoped role can leave staff missing a key permission for their actual job (discovered as a `/app/403` mid-task) or, in the opposite direction, over-privileged because the Owner defaulted to granting more than needed.
- No permission templates/presets exist yet — every account rebuilds "fulfillment clerk"-shaped roles from scratch from the 30 raw keys.
- Deactivation is soft and reversible, but a deactivated user's in-flight assignments/mentions (see the Merchant Staff project's notes/mentions/assignment work) still need a human to reassign — deactivating someone mid-order doesn't automatically hand off their open work.

## A day in the life

Marcus was hired as Priya's fulfillment clerk. He signs in to `merchant-web` and sees a nav scoped to what his role actually grants — Orders and Inventory are there; Settings → Roles, Payments, and Developer API keys aren't, because his role holds none of `roles:*`, `payments:*`, or `api_keys:*`. A new order comes in from the storefront; he opens it, confirms stock, and clicks through to purchase a Shippo label directly from the order — tracking number and label URL land back on the order automatically. A customer emails asking for a refund on a damaged item; Marcus opens the order but the refund button isn't there — his role has `orders:write` but not `orders:refund` — so he flags it to Priya instead of getting stuck wondering why the action is missing. Later he adjusts inventory after a stock recount, which appends to the movement ledger rather than silently overwriting the count, so there's a record of who changed what and when.
