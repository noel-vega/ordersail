// @ts-check
import eslint from '@eslint/js';
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
      // docs/observability.md: object first, no IDs interpolated into `msg`
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='logger'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length>0]",
          message:
            "Log fields, not interpolated strings: logger.info({ event, orderId }, 'Short message') — see docs/observability.md",
        },
      ],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // rest-siblings are the standard "omit this key" destructure idiom
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
