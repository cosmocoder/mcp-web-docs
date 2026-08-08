import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['node_modules', 'build']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: {
      js,
    },
    extends: ['js/recommended'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'brace-style': ['error', 'stroustrup', { allowSingleLine: false }],
      curly: ['error', 'all'],
    },
  },
  tseslint.configs.recommended,
  {
    // A deferred transaction that opens with a read fails its upgrade to a write without waiting out
    // busy_timeout. BEGIN_WRITE_TRANSACTION states the rule; this is what stops the next call site
    // being written with the reflex spelling, compiling, and passing every test.
    files: ['src/storage/**/*.ts'],
    ignores: ['src/storage/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='BEGIN TRANSACTION']",
          message: 'Open transactions with BEGIN_WRITE_TRANSACTION so the write lock is taken at BEGIN.',
        },
      ],
    },
  },
]);
