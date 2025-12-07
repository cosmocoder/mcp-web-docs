import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['node_modules', 'build']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: {
      js
    },
    extends: ['js/recommended'],
    languageOptions: {
      globals: globals.node
    }
  },
  tseslint.configs.recommended,
]);
