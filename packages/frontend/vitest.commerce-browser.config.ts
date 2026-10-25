import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['lib/**/__tests__/*.browser.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
