# Context Map

Contexts get a `CONTEXT.md` lazily — when a term in them is actually resolved,
not upfront. This map lists the ones that exist.

## Contexts

- [Identity](./apps/merchant-api/src/identity/CONTEXT.md): accounts, users,
  credentials, roles and permissions

## Relationships

The enforced dependency edges between `merchant-api`'s bounded contexts live in
[apps/merchant-api/ARCHITECTURE.md](./apps/merchant-api/ARCHITECTURE.md), which
is the source of truth ESLint's `boundaries` policy is written against. This map
does not restate them.
