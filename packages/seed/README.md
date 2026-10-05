# seed

Seeds local dev with a demo sneaker-store catalog ("Sneaker Depot") — brands, categories,
13 real shoe products, and a real matching photo for each — so `merchant-web` never
starts from an empty catalog. It also seeds 40 registered storefront customers and about
90 days of paid web order history (~400 orders): line items, a `stripe` payment with fake
`cs_test_seed_*` ids, ship-to addresses, `sold` stock movements, and fulfillments with fake
tracking. Everything older than 3 days is shipped; newer orders are left to fulfill.

Order dates are relative to when the seed runs, so the dashboard always shows "the last 90
days". Run `npm run reset` to move the window forward. Order history is written only once:
it's skipped when the account already has orders. Refunding or canceling a seeded order
through Stripe will fail, because the Stripe ids are fake.

## Demo logins

merchant-web (store owner):

```
Email:    owner@sneakerdepot.test
Password: password123
```

storefront-web (any seeded customer; all 40 share the password, emails are
`first.last@example.com` and the seed prints one at the end):

```
Email:    ava.thompson@example.com
Password: password123
```

Generated data (customers, orders, dates, fulfillments) comes from the fixed-seed PRNG in
`scripts/seed-random.ts`, so every `npm run reset` produces the same store.

## Usage

```bash
npm run seed
```

Builds `db` and `storage` first (both are consumed by package name, see below), then runs
the seed. Safe to re-run any time — every entity is looked up by its natural key before
insert, so re-seeding only adds whatever's missing and never duplicates rows.

Requires Postgres and MinIO running locally (see `packages/db` and `packages/storage`),
and this package's own `.env` (copy `.env.example`) pointing at both.

## Regenerating the seed images

The photos in `scripts/seed-images/` are downloaded once and committed — `seed.ts` reads
them from disk, it never hits the network. Only re-run this if the product list in
`scripts/seed.ts` changes:

```bash
npm run seed:images
```

## Why this is its own package

`seed.ts` needs both `db` (for the schema/client) and `storage` (to upload images to
MinIO) — dependencies that don't belong on `db` itself, which is otherwise just schema
and migrations. Because this package imports `db`/`storage` by name rather than reaching
into `db`'s source directly, both need to be built first; the `seed` script above handles
that automatically.
