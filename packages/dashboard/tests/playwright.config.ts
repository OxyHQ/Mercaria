import { defineConfig } from '@playwright/test';

/** Component acceptance against the app's real Metro module graph, not an RN alias. */
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, timeout: 60_000,
  expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: '../../../test-results/dashboard-components',
  use: { baseURL: process.env.DASHBOARD_BASE_URL ?? 'http://localhost:8161',
    browserName: 'chromium', viewport: { width: 800, height: 800 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
