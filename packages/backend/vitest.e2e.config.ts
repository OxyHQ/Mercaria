import { defineConfig } from 'vitest/config';

/**
 * The controls on the #69 real-store evidence harness (`scripts/e2e/`).
 *
 * A SEPARATE config from `vitest.config.ts`, for two reasons rather than tidiness:
 *
 *  - the main config's `include` reaches `src/**` plus
 *    `scripts/**\/__tests__/**` and nothing else under `scripts/`, while this one
 *    collects any `*.test.ts` under `scripts/e2e/`. Both harness cases sit in a
 *    `__tests__` directory today, so BOTH configs collect both — deliberately:
 *    #300 widened the main include precisely so the redaction controls run in
 *    CI, and this config stays the one that can run them alone;
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
