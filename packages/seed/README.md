# seed

Seeds local dev with a demo sneaker-store catalog ("Sneaker Depot") — brands, categories,
13 real shoe products, and a real matching photo for each — so `merchant-web` never
starts from an empty catalog. It also seeds 40 registered storefront customers.

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

Generated data (customers' signup dates, and so on) comes from the fixed-seed PRNG in
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
