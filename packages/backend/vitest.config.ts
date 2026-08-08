import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * ONE real database.
     *
     * `vitest.pg.globalSetup.ts` creates a throwaway, fully-migrated Postgres
     * database for the repositories and the `*.realdb.test.ts` files that
     * exercise real SQL semantics. It needs a server to create that database ON,
     * named by `TEST_DATABASE_URL` — start one with
     * `docker compose -f docker-compose.postgres.yml up -d postgres`.
     *
     * It FAILS rather than skipping when no server is reachable, deliberately: a
     * harness that skipped would report a green suite for a migration whose SQL
     * was never executed, which is the one outcome this whole phase exists to
     * prevent.
     *
     * ONE, and it stays one: a global setup that starts a server no test reads
     * is the slowest possible no-op.
     */
    globalSetup: ['./vitest.pg.globalSetup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    testTimeout: 10000,
    // Creating and migrating the throwaway database can take a while on a cold
    // cache.
    hookTimeout: 120_000,
  },
});
