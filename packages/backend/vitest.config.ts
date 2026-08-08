import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * Both real servers, because the suite now spans both stores.
     *
     * A MongoDB replica set for the moderation write tests, and a throwaway
     * PostgreSQL database for the payment and ledger ones. Everything else here
     * mocks its models, which cannot tell whether the SERVER would accept a
     * write — the exact blind spot both harnesses exist to close. The Postgres
     * one additionally holds properties nothing else can: a balanced-ledger
     * invariant asserted by a trigger, and a unique index doing the deduping.
     *
     * Order matters only in that Mongo comes first; neither depends on the
     * other. `vitest.pg.globalSetup.ts` needs `TEST_DATABASE_URL` pointed at a
     * server it may create and drop databases on — it never writes to the
     * database named in that URL.
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
