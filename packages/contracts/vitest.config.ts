import { defineConfig } from 'vitest/config';

/**
 * The contract's own suite: schema behaviour, the request-error classifier, the
 * route registry and the OpenAPI document built from it. No network, no
 * database.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
