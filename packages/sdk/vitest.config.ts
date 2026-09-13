import { defineConfig } from 'vitest/config';

/**
 * The SDK's unit suite. Node environment, no network: every request goes to a
 * `fetch` double (`test/helpers.ts`). vitest rather than `bun test` because
 * `client-test-runners.test.ts` recognises a runner by `vitest` in the `test`
 * script and requires CI to invoke it — and running under Node is also the
 * stricter check for an SDK whose first consumer is a Node backend.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
