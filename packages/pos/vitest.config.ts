import { defineConfig } from 'vitest/config';

/**
 * The point of sale's test runner (#469).
 *
 * ## Why this package needs its OWN runner rather than a shared one
 *
 * A test that imports across a package boundary compiles the imported source
 * under the IMPORTING package's `strict` setting. `packages/pos` is
 * `strict: true` and `packages/backend` is `strict: false`, so a POS module
 * exercised from the backend's program loses every null-safety check it was
 * written to rely on, and the test goes green having measured a laxer language
 * than the one that compiles the code in production.
 *
 * #469 measured the harmless direction of that mechanism and retracted a filed
 * defect because of it: a guard reported as narrowing nothing was correct under
 * its own package's `strict: true` and only failed under the backend's
 * `strict: false`. Pointed the other way the same mechanism hides a real error
 * rather than inventing one, and nothing would report it. A per-package runner
 * keeps each package's code under its own compiler settings, which is a
 * correctness property rather than a convenience.
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
 * `validate:i18n-strings`, `validate:money-formatting` and
 * `validate:rtl-classes` scan this whole tree as text, including the files that
 * import a renderer, and they deliberately do NOT skip test files — so every
 * file this runner picks up is still subject to all of them. This runner adds
 * BEHAVIOUR coverage over the pure modules and removes SHAPE coverage from
 * nothing.
 */
export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
