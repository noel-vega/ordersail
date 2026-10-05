// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import { logCallSelectors } from 'logging/eslint';
import tseslint from 'typescript-eslint';

// no-restricted-syntax for every file. ESLint replaces a rule's options rather
// than merging them, so the override below restates this list — add here.
const restrictedSyntax = [...logCallSelectors];

// A plain WorkerHost closes its Worker only after the queues have closed, so a
// job in flight at shutdown can't enqueue (see src/draining-worker-host.ts).
const drainingWorkerHostSelectors = [
  {
    selector: "ClassDeclaration[superClass.name='WorkerHost']",
    message:
      'Extend DrainingWorkerHost, not WorkerHost: its Worker must drain before the queues close on shutdown.',
  },
];

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
      'no-restricted-syntax': ['error', ...restrictedSyntax, ...drainingWorkerHostSelectors],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // rest-siblings are the standard "omit this key" destructure idiom
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // the one class allowed to extend WorkerHost
    files: ['src/draining-worker-host.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
);
