import { defineConfig } from 'vitest/config';

/**
 * The storefront's test runner.
 *
 * ## Narrow on purpose
 *
 * `lib/**` only, the node environment, and no jsdom — so what is testable here
 * is exactly the PURE composition (`lib/catalog/`'s facet grammar, variant-axis
 * availability and comparability rules), which imports types and closed tuples
 * from `@mercaria/shared-types` and nothing else.
 *
 * A wider config would invite component tests, and this package has no shape
 * for those yet: every existing storefront check lives in the backend suite and
 * SCANS source as text. Those gates are not replaced by this and should not be
 * moved here — they cover the whole tree, including files that import a
 * renderer.
 *
 * ## Why not the backend suite, which runs everything else
 *
 * Its `rootDir` is its own package root by an explicit decision in its
 * `tsconfig.json`, so a backend test cannot IMPORT a file from another package
 * (TS6059) — which is why every storefront check there reads text instead.
 * Excluding one test from that program to get around it also makes
 * `parserOptions.project` unable to parse it, leaving the file neither
 * typechecked nor linted. Measured, on this branch, before this config existed.
 */
export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
