import { defineConfig } from 'vitest/config';

/**
 * The merchant dashboard's test runner (#469).
 *
 * ## Why this package needs its OWN runner rather than a shared one
 *
 * A test that imports across a package boundary compiles the imported source
 * under the IMPORTING package's `strict` setting. That is not a style question:
 * `packages/dashboard` is `strict: true` and `packages/backend` is
 * `strict: false`, so a dashboard module exercised from the backend's program
 * loses every null-safety check it was written to rely on, and the test goes
 * green having measured a laxer language than the one that compiles the code in
 * production.
 *
 * The repository has already paid for the harmless direction of that mechanism:
 * #469 filed a `boundedEntry` guard as a defect that "narrows nothing", and it
 * was a false positive produced entirely by a test's PLACEMENT — the module is
 * correct under its own `strict: true` and only fails under the backend's
 * `strict: false`. The retraction is the argument for this file. The same
 * mechanism pointed the other way hides a real error instead of inventing one,
 * and nothing would report it.
 *
 * A per-package runner keeps each package's code under its own compiler
 * settings, which is a correctness property rather than a convenience.
 *
 * ## Narrow on purpose — `lib/**` only, node environment, no jsdom, no React
 *
 * The same shape as `packages/frontend/vitest.config.ts`, for the same measured
 * reason recorded there: importing any component pulls `react-native`, whose
 * `index.js` is Flow source that Rollup cannot parse
 * (`Expected 'from', got 'typeOf'`). Making that work means aliasing to
 * `react-native-web` and re-implementing Metro's platform-extension resolution
 * inside vitest — which would then test a THIRD module graph neither the native
 * nor the web build ships. What is testable without a renderer is exactly the
 * pure logic, and that is what belongs here.
 *
 * ## The scanning gates are NOT replaced by this
 *
 * `validate:i18n-strings`, `validate:money-formatting`, `validate:rtl-classes`
 * and `validate:authoring-schema` scan this whole tree as text, including the
 * files that import a renderer, and they deliberately do NOT skip test files —
 * so every file this runner picks up is still subject to all of them. That is
 * the right way round: this runner adds BEHAVIOUR coverage over the pure
 * modules and removes SHAPE coverage from nothing.
 */
export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
