import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * TWO real databases, because this package is mid-migration and both stores
     * are live.
     *
     * `vitest.globalSetup.ts` starts a MongoDB replica set for the moderation
     * write tests; everything still on Mongo mocks its models, which cannot tell
     * whether the SERVER would accept an update document.
     *
     * `vitest.pg.globalSetup.ts` creates one throwaway, fully-migrated Postgres
     * database for the ported repositories and the `*.realdb.test.ts` files that
     * exercise real SQL semantics. It needs a server to create that database ON,
     * named by `TEST_DATABASE_URL` — start one with
     * `docker compose -f docker-compose.postgres.yml up -d postgres`.
     *
     * It FAILS rather than skipping when no server is reachable, deliberately: a
     * harness that skipped would report a green suite for a migration whose SQL
     * was never executed, which is the one outcome this whole phase exists to
     * prevent. Both entries stay until the last Mongo-backed test is gone.
     */
    globalSetup: ['./vitest.globalSetup.ts', './vitest.pg.globalSetup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // Increase timeout for tests that mock MongoDB
    testTimeout: 10000,
    // The replica set can take a while to come up on a cold cache.
    hookTimeout: 120_000,
  },
});
