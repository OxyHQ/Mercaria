import { defineConfig } from '@playwright/test';

// Uses the running Expo app and local seeded API. Never starts or reseeds a DB.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  outputDir: '../../../test-results/storefront',
  use: {
    baseURL: process.env.STOREFRONT_BASE_URL ?? 'http://localhost:8160',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
