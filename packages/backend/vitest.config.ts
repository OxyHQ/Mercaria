import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    /**
     * `scripts/**` is here as well as `src/**`, and that is deliberate rather
     * than convenient: the #69 evidence harness carries the redaction controls,
     * and a redactor that is proven only when somebody points a custom config at
     * it is proven but NOT protected — a regression in it ships silently, and
     * what it protects is credentials in an artefact meant to be pasted into an
     * issue. These cases read no database, so they cost the globalSetup nothing
     * they were not already paying.
     */
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
    ],
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
    /**
     * 30s, raised from 10s on evidence, not on suspicion.
     *
     * On a 32-core box a full local run's slowest realdb tests (real Postgres
     * round trips over Stripe/eBay/cart-merge flows) land between 500ms and
     * 8.6s, with p99 at 842ms and p99.9 at 2895ms across 4389 measured tests —
     * nowhere near 10s. But `Deploy to AWS`'s own duplicate test job (and this
     * suite's own CI run) fails intermittently on a DIFFERENT victim each
     * time — cart-guest.integration, checkout.stripe.realdb, cart-merge,
     * payment.service, ebay-ingestion — always the SAME message, `Test timed
     * out in 10000ms`, never an assertion mismatch. That signature (generic
     * timeout, different file each run) is resource contention on a 2-4 vCPU
     * GitHub-hosted runner, not a hang: a hang would time out the SAME test
     * every time, and every named victim measured here completes between
     * 511ms and 3.8s on real hardware, never near the old 10s ceiling. 30s
     * gives roughly 8x the slowest of those and 3.5x the single slowest test
     * seen overall (8.6s, channel-push-contract's large-catalogue scenario) —
     * comfortable margin for a runner with a fraction of the
     * cores, while staying far below `Lint & Test`'s own 15-minute job
     * timeout. No retries: a retry would hide a genuine race in exactly the
     * ebay-ingestion file already flagged as timing-sensitive in its own
     * history (see AGENTS.md's eBay section).
     */
    testTimeout: 30000,
    // Creating and migrating the throwaway database can take a while on a cold
    // cache.
    hookTimeout: 120_000,
  },
});
