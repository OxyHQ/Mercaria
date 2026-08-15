import { defineConfig } from 'vitest/config';

/**
 * The controls on the #69 real-store evidence harness (`scripts/e2e/`).
 *
 * A SEPARATE config from `vitest.config.ts`, for two reasons rather than tidiness:
 *
 *  - the main config's `include` is `src/**` and the harness deliberately lives
 *    under `scripts/`, since it is an operator tool rather than shipped code;
 *  - the main config's `globalSetup` creates a throwaway, fully-migrated Postgres
 *    database per run. These cases exercise a pure redactor and a file writer and
 *    read no database at all, so pointing them at that setup would be the slowest
 *    possible no-op — the thing `vitest.config.ts`'s own comment warns against.
 *
 * Run with:
 *   bun run --cwd packages/backend test:e2e-harness
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/e2e/**/*.test.ts'],
  },
});
