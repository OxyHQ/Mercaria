/**
 * The MINIMAL ESLint flat config for the three Expo apps — the rules Biome
 * lacks, and nothing else.
 *
 * Formatting and every other lint rule (the house set, React's hooks rules,
 * `useJsxKeyInIterable`, `noDangerouslySetInnerHtml`) live in Biome
 * (`biome.jsonc` at the repo root), which lints every package. What is left
 * here is `eslint-plugin-expo`'s two env-var rules: Metro inlines
 * `process.env.EXPO_PUBLIC_*` only when it is read as a plain static member
 * access, so a destructured or computed read compiles, typechecks and
 * silently ships `undefined` to production. Biome has no equivalent.
 *
 * `frontend`, `dashboard` and `pos` each re-export this file from their own
 * `eslint.config.mjs` (`bun run --filter <app> lint:expo`), so a per-app
 * divergence has to be written down as one. The TypeScript parser is here only
 * so ESLint can READ `.ts`/`.tsx`; no typescript-eslint rule is enabled.
 */

import tsparser from '@typescript-eslint/parser';
import expo from 'eslint-plugin-expo';

export default [
  {
    // `.expo/` is generated on every build and `*.d.ts` are generated ambient
    // declarations — nothing in either reads an env var.
    ignores: ['dist/**', 'node_modules/**', '.expo/**', '**/*.d.ts'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsparser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
    },
  },
];
