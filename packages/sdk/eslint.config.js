/**
 * ESLint for @mercaria.co/sdk.
 *
 * Its own config rather than the backend's or the apps': this package is
 * neither a server nor an Expo app, and it is the one package here whose
 * source must run unchanged on Node, Bun, browsers and React Native. The rule
 * set is the house set (`@typescript-eslint/no-unused-vars` with the backend's
 * options) plus the rules that matter for a published, isomorphic client:
 *
 *  - `no-restricted-imports` refuses Node built-ins in `src/`. `tsc` also fails
 *    on one (`src/` compiles with `types: []`), but with "cannot find module",
 *    which reads as a missing dependency to install rather than a rule; this
 *    says why. The browser and React Native bundles in `scripts/smoke.mjs` are
 *    the backstop that measures the built output.
 *  - `no-console` in `src/`: the SDK never logs, so a token can never reach a
 *    log line through it.
 *  - `@typescript-eslint/no-explicit-any` as an error: the parsers are the
 *    wall between an untrusted body and a typed DTO, and `any` is a hole in it.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https',
  'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'worker_threads', 'zlib',
];

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsparser,
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off', // TypeScript handles this
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['node:*'], message: 'src/ ships to browsers and React Native: no Node built-ins.' }],
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message: 'src/ ships to browsers and React Native: no Node built-ins.',
          })),
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
];
