# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root: it points at one `CONTEXT.md` per context. Read each one
  relevant to the topic.
- **`docs/adr/`**: system-wide ADRs. Read the ones that touch the area you're about to work in.
- **Context-scoped ADRs**: also check `apps/<app>/docs/adr/` and `packages/<pkg>/docs/adr/` for
  decisions local to the context you're working in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **multi-context** repo (npm workspaces + nx). Contexts are workspace packages under
`apps/*` and `packages/*`, plus the bounded contexts inside `apps/merchant-api/src/`.

```
/
├── CONTEXT-MAP.md                      ← points at every CONTEXT.md below
├── docs/adr/                           ← system-wide decisions
├── apps/
│   ├── merchant-api/
│   │   ├── CONTEXT.md
│   │   ├── docs/adr/                   ← app-scoped decisions
│   │   └── src/
│   │       ├── catalog/CONTEXT.md      ← bounded contexts (modular monolith)
│   │       ├── identity/CONTEXT.md
│   │       ├── payments/CONTEXT.md
│   │       ├── platform/CONTEXT.md
│   │       ├── sales/CONTEXT.md
│   │       └── stock/CONTEXT.md
│   ├── storefront-api/CONTEXT.md
│   ├── merchant-web/CONTEXT.md
│   └── worker/CONTEXT.md
└── packages/
    ├── db/CONTEXT.md
    └── payments/CONTEXT.md
```

Nothing here needs to exist upfront. `/domain-modeling` creates these lazily, as terms and decisions
actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
