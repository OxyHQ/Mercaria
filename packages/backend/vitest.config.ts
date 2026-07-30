import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * A real MongoDB replica set for the moderation write tests.
     *
     * Everything else here mocks its models, which cannot tell whether the
     * SERVER would accept an update document — see `vitest.globalSetup.ts`.
     */
    globalSetup: ['./vitest.globalSetup.ts'],
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
