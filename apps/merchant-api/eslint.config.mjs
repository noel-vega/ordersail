// @ts-check
import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import { logCallSelectors } from 'logging/eslint';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // docs/observability.md log-line contract
      'no-restricted-syntax': ['error', ...logCallSelectors],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // rest-siblings are the standard "omit this key" destructure idiom
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },

  // ── Bounded-context boundaries (see ARCHITECTURE.md) ──────────────────────
  // src/ is 6 domain contexts (src/<context>/) + a shared kernel (src/shared/).
  // A context may only reach another context through its `index.ts` barrel, and
  // only along the edges declared below. Root files (src/*.ts) are the
  // composition root and aren't checked.
  {
    files: ['src/*/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        // order matters — first match wins (src/shared also matches 'src/*').
        // partialMatch:false anchors the pattern to the project root so a
        // workspace import like `db/schema` (…/packages/db/src/schema) can't be
        // misread as a context named "schema".
        { type: 'shared', pattern: 'src/shared', partialMatch: false },
        {
          type: 'context',
          pattern: 'src/*',
          capture: ['context'],
          partialMatch: false,
        },
      ],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: `${import.meta.dirname}/tsconfig.json`,
        },
        node: true,
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            "'{{ dependency.context }}' is not an allowed dependency of '{{ file.context }}' (or isn't imported through its index.ts barrel) — see apps/merchant-api/ARCHITECTURE.md",
          policies: [
            // the shared kernel is a leaf — pure infra, no domain deps.
            // deep imports into shared are fine (no barrel ceremony there).
            {
              from: { element: { type: 'shared' } },
              allow: { to: { element: { type: 'shared' } } },
            },
            { from: { element: { type: 'context' } }, allow: { to: { element: { type: 'shared' } } } },
            // a context may import its own files, any internal path
            {
              from: { element: { type: 'context' } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: '{{ from.element.captured.context }}' },
                  },
                },
              },
            },
            // cross-context edges — keep in sync with ARCHITECTURE.md.
            // fileInternalPath: index.ts ⇒ the target's barrel only.
            {
              from: { element: { type: 'context', captured: { context: '{catalog,stock,payments}' } } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: 'identity' },
                    fileInternalPath: 'index.ts',
                  },
                },
              },
            },
            {
              // sales → payments is the M2 refund path: sales/orders/ports/
              // (PaymentsPort + PaymentsAdapter) is the anti-corruption layer,
              // the rest of sales depends only on the local port. See
              // ARCHITECTURE.md § Cross-context communication.
              from: { element: { type: 'context', captured: { context: 'sales' } } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: '{identity,catalog,stock,payments}' },
                    fileInternalPath: 'index.ts',
                  },
                },
              },
            },
            {
              // catalog → stock: where opening stock goes, through
              // catalog/products/ports/ (LocationsPort + LocationsAdapter)
              from: { element: { type: 'context', captured: { context: 'catalog' } } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: 'stock' },
                    fileInternalPath: 'index.ts',
                  },
                },
              },
            },
            {
              // platform/dashboard is the documented cross-context read-model;
              // platform → stock is pos-devices' location check, through
              // platform/pos-devices/ports/ (LocationsPort + LocationsAdapter)
              from: { element: { type: 'context', captured: { context: 'platform' } } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: '{identity,sales,stock}' },
                    fileInternalPath: 'index.ts',
                  },
                },
              },
            },
          ],
        },
      ],
      // a src/<context>/ file that matches no element = a config gap
      'boundaries/no-unknown-files': 'error',
    },
  },

  // ── Data-access read-graph + port-only service edges ──────────────────────
  // (see ARCHITECTURE.md § Data access and § Cross-context communication)
  //
  // Read-graph: packages/db has a per-domain entrypoint per context
  // (db/identity, db/catalog, …). A context imports its OWN db/<domain> plus
  // the entrypoints on its read-graph; root `db` and `db/schema` are blocked in
  // every context (they're the full schema — for platform/dashboard,
  // migrations, and the other apps).
  //
  // Port-only edges: where a context calls another context's services, only
  // its anti-corruption layer (ports/) and the module that wires it may import
  // that context; the rest depends on the local port.
  //
  // Both are `no-restricted-imports`, and a later flat-config block replaces
  // an earlier one's options for the same rule — so each context gets one
  // block carrying both, plus one block per ports/ folder that drops only the
  // edge that folder is the adapter for.
  ...(() => {
    // context → the db/* entrypoints it is NOT allowed to import
    const denied = {
      // identity reads only its own tables — the identity → stock edge went
      // away when signup stopped seeding a Default location (OS-689)
      identity: ['db', 'db/schema', 'db/catalog', 'db/stock', 'db/sales', 'db/payments'],
      catalog: ['db', 'db/schema', 'db/identity', 'db/sales', 'db/payments'],
      stock: ['db', 'db/schema', 'db/sales', 'db/payments'],
      sales: ['db', 'db/schema', 'db/payments'],
      payments: ['db', 'db/schema', 'db/catalog', 'db/stock', 'db/sales'],
      // shared kernel: only root `db` (the DRIZZLE provider) — never the schema
      shared: ['db/schema', 'db/identity', 'db/catalog', 'db/stock', 'db/sales', 'db/payments'],
      // platform is exempt — dashboard is the cross-context read-model
      platform: [],
    };
    // context → { target context: the files allowed to import it }
    const portOnly = {
      catalog: {
        stock: ['src/catalog/products/ports/**', 'src/catalog/products/products.module.ts'],
      },
      platform: {
        sales: ['src/platform/dashboard/ports/**', 'src/platform/dashboard/dashboard.module.ts'],
        stock: [
          'src/platform/pos-devices/ports/**',
          'src/platform/pos-devices/pos-devices.module.ts',
          'src/platform/dashboard/ports/**',
          'src/platform/dashboard/dashboard.module.ts',
        ],
      },
      sales: {
        payments: ['src/sales/orders/ports/**', 'src/sales/orders/orders.module.ts'],
      },
    };

    const rule = (ctx, targets) => [
      'error',
      {
        paths: denied[ctx].map((name) => ({
          name,
          message: `${ctx} may not import '${name}' — use db/${ctx} + its read-graph. See apps/merchant-api/ARCHITECTURE.md § Data access.`,
        })),
        patterns: targets.map((target) => ({
          group: [`src/${target}`, `src/${target}/*`],
          message: `${ctx} reaches ${target} only through its ports/ adapter, not directly — see apps/merchant-api/ARCHITECTURE.md § Cross-context communication`,
        })),
      },
    ];

    return Object.keys(denied).flatMap((ctx) => {
      const edges = portOnly[ctx] ?? {};
      const targets = Object.keys(edges);
      return [
        {
          files: [`src/${ctx}/**/*.ts`],
          ignores: ['src/**/*.spec.ts'],
          rules: { 'no-restricted-imports': rule(ctx, targets) },
        },
        // one override per allowed glob, banning only the targets that glob
        // isn't listed under — a ports/ folder may reach several contexts
        // (platform/dashboard → sales + stock)
        ...[...new Set(Object.values(edges).flat())].map((glob) => ({
          files: [glob],
          ignores: ['src/**/*.spec.ts'],
          rules: {
            'no-restricted-imports': rule(
              ctx,
              targets.filter((t) => !edges[t].includes(glob)),
            ),
          },
        })),
      ];
    });
  })(),
);
