// @ts-check
import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
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
              // platform/dashboard is the documented cross-context read-model
              from: { element: { type: 'context', captured: { context: 'platform' } } },
              allow: {
                to: {
                  element: {
                    type: 'context',
                    captured: { context: '{identity,sales}' },
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

  // ── Data-access read-graph (see ARCHITECTURE.md § Data access) ────────────
  // packages/db has a per-domain entrypoint per context (db/identity, db/catalog,
  // …). A context imports its OWN db/<domain> plus the entrypoints on its
  // read-graph; root `db` and `db/schema` are blocked in every context (they're
  // the full schema — for platform/dashboard, migrations, and the other apps).
  ...(() => {
    // context → the db/* entrypoints it is NOT allowed to import
    const denied = {
      // identity → stock: tenant provisioning (account.service `provision`) seeds
      // the new tenant's default location in the same transaction as the account.
      // Provisioning write — known coupling, revisit via an `account.created`
      // event. See ARCHITECTURE.md.
      identity: ['db', 'db/schema', 'db/catalog', 'db/sales', 'db/payments'],
      catalog: ['db', 'db/schema', 'db/identity', 'db/sales', 'db/payments'],
      stock: ['db', 'db/schema', 'db/sales', 'db/payments'],
      sales: ['db', 'db/schema', 'db/payments'],
      payments: ['db', 'db/schema', 'db/catalog', 'db/stock', 'db/sales'],
      // shared kernel: only root `db` (the DRIZZLE provider) — never the schema
      shared: ['db/schema', 'db/identity', 'db/catalog', 'db/stock', 'db/sales', 'db/payments'],
      // platform is exempt — dashboard is the cross-context read-model
    };
    return Object.entries(denied).map(([ctx, names]) => ({
      files: [`src/${ctx}/**/*.ts`],
      ignores: ['src/**/*.spec.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: names.map((name) => ({
              name,
              message: `${ctx} may not import '${name}' — use db/${ctx} + its read-graph. See apps/merchant-api/ARCHITECTURE.md § Data access.`,
            })),
          },
        ],
      },
    }));
  })(),

  // ── dashboard → sales goes through the adapter, nowhere else ──────────────
  // platform/dashboard is the cross-context read-model, but only its
  // anti-corruption layer (ports/) — and the module that wires it — may touch
  // src/sales. dashboard.service / entities depend on the local SalesPort.
  {
    files: ['src/platform/**/*.ts'],
    ignores: [
      'src/platform/dashboard/ports/**',
      'src/platform/dashboard/dashboard.module.ts',
      'src/**/*.spec.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['src/sales', 'src/sales/*'],
              message:
                "reach sales through platform/dashboard/ports (SalesPort + SalesAdapter), not directly — see apps/merchant-api/ARCHITECTURE.md § Cross-context communication",
            },
          ],
        },
      ],
    },
  },
);
