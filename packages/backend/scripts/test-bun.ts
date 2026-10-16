/**
 * The backend unit suite, executed by Bun — the runtime production serves on.
 *
 * Production runs `bun packages/backend/dist/index.js` (root Dockerfile), while
 * `bun run test` is vitest on Node. So the suite also runs here, under Bun's
 * runtime and `bun test`, to catch a module that behaves differently on the
 * runtime it ships on (crypto, streams, Intl/ICU, `node:http`).
 *
 * The database is the SAME harness vitest uses: `vitest.pg.globalSetup.ts`
 * creates one throwaway, fully-migrated database on the server
 * `TEST_DATABASE_URL` names, this suite runs against it, and it is dropped
 * afterwards. A long-lived database is wrong here for the reason it is wrong
 * under vitest: several files use fixed ids and assume they start clean.
 *
 * `--isolate` gives each file a fresh global and module registry. Without it
 * one file's `vi.mock` (bun:test's `mock.module`, process-wide and NOT hoisted)
 * leaks into every file after it.
 *
 * What does NOT run here, and why:
 *  - `*.realdb.test.ts` stay on vitest. They lean on vitest-only APIs and on
 *    vitest's worker model; CI's image smoke (`.github/scripts/smoke-api-image.sh`)
 *    is what proves Postgres under Bun, against the real image.
 *  - `EXCLUDED` below: files that use a vitest API bun:test does not implement,
 *    or rely on vitest-specific semantics. Each is a RUNNER gap, not a runtime
 *    difference — measured 2026-10-12 on Bun 1.4.3, every failure in these
 *    files was one of the reasons given beside it. A file is removed from the
 *    list by porting it (see `src/__tests__/ecosystemActivity.test.ts` in Nilo
 *    for the pattern), never by weakening its assertions.
 *
 * Usage (from packages/backend): `bun run test:bun`. Extra arguments are passed
 * to `bun test`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { setup, teardown } from '../vitest.pg.globalSetup.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

/** Runner gaps, grouped by the bun:test feature each file needs and lacks. */
const EXCLUDED: Readonly<Record<string, readonly string[]>> = {
  // `vi.hoisted`, `vi.mock(path, async (importOriginal) => …)`, `vi.mocked`,
  // `vi.resetModules`. bun:test's `mock.module` is neither hoisted nor handed
  // the original module, so a partial mock replaces the whole module and named
  // imports go missing; there is no module-registry reset at all.
  'module mocking (vi.hoisted / importOriginal / vi.mocked / vi.resetModules)': [
    'src/__tests__/ecosystemActivity.test.ts',
    'src/capabilities/__tests__/capability-authority.test.ts',
    'src/capabilities/__tests__/mercaria-domain-authority.test.ts',
    'src/capabilities/__tests__/mercaria-handlers.test.ts',
    'src/capabilities/__tests__/oxy-service-client.test.ts',
    'src/config/__tests__/billing-cohort.test.ts',
    // These two re-derive the frozen `config` under a stubbed environment
    // (vi.resetModules + vi.stubEnv), so each case is a fresh import of
    // config/index.ts; derived-commerce-gates also re-imports a consumer.
    'src/config/__tests__/derived-commerce-gates.test.ts',
    'src/config/__tests__/node-env.test.ts',
    'src/connectors/shopify/__tests__/shopify-contract.test.ts',
    'src/connectors/woocommerce/__tests__/woocommerce-contract.test.ts',
    'src/controllers/__tests__/referral-program-operator-list.test.ts',
    'src/lib/__tests__/redis-db-index.test.ts',
    'src/routes/__tests__/billing-cohort-stripe.integration.test.ts',
    'src/routes/__tests__/capabilities.test.ts',
    'src/routes/__tests__/catalog-attribute-display-units.test.ts',
    'src/routes/__tests__/catalog-rollout-cohorts.test.ts',
    'src/routes/__tests__/digital-routes.test.ts',
    'src/routes/__tests__/health-redis.test.ts',
    'src/routes/__tests__/internal-analytics.test.ts',
    'src/routes/__tests__/internal-backfill.test.ts',
    'src/routes/__tests__/internal-canonical-catalog.test.ts',
    'src/routes/__tests__/internal-catalog-attributes.test.ts',
    'src/routes/__tests__/internal-catalog-metrics.test.ts',
    'src/routes/__tests__/internal-commerce-graph.test.ts',
    'src/routes/__tests__/internal-offers.test.ts',
    'src/routes/__tests__/internal-payments.test.ts',
    'src/routes/__tests__/internal-retail-eligibility.test.ts',
    'src/routes/__tests__/internal-supplier-preflight.test.ts',
    'src/routes/__tests__/payments-routes.test.ts',
    'src/routes/__tests__/review-helpfulness.test.ts',
    'src/routes/__tests__/review-media.test.ts',
    'src/routes/__tests__/stripe-webhook.integration.test.ts',
    'src/routes/admin/__tests__/product-media.test.ts',
    'src/routes/admin/__tests__/products-pin-release-route.test.ts',
    'src/services/__tests__/catalog-description-media.test.ts',
    'src/services/__tests__/catalog-hydration-variant-axes.test.ts',
    'src/services/__tests__/catalog-media-sync.test.ts',
    'src/services/__tests__/catalog-video-sync.test.ts',
    'src/services/__tests__/checkout.payment-gate.test.ts',
    'src/services/__tests__/checkout.service.test.ts',
    'src/services/__tests__/connector-sync.service.test.ts',
    'src/services/__tests__/connector-webhook-reregistration.service.test.ts',
    'src/services/__tests__/connector-webhook-woocommerce.test.ts',
    'src/services/__tests__/connector-webhook.test.ts',
    'src/services/__tests__/moderation-enforcement-guards.test.ts',
    'src/services/__tests__/order.service.test.ts',
    'src/services/__tests__/product-type-publication.test.ts',
    'src/services/__tests__/product-type-value-policy.test.ts',
    'src/services/__tests__/report-intake.service.test.ts',
    'src/services/__tests__/shopping-thread.test.ts',
    'src/services/__tests__/v1-order-buyer-serving.test.ts',
    'src/services/attributes/__tests__/constraint-validation.test.ts',
    'src/services/billing/peable/__tests__/register.test.ts',
    'src/services/billing/stripe/__tests__/cohort-reader.test.ts',
    'src/services/catalog-authoring/__tests__/draft-upgrade.test.ts',
    'src/services/catalog-media/__tests__/verify.test.ts',
    'src/services/goway/__tests__/places.test.ts',
    'src/services/moovo/__tests__/moovo-registration.test.ts',
    'src/services/payments/__tests__/checkout-rail.test.ts',
    'src/services/payments/__tests__/native-rail.test.ts',
    'src/services/payments/__tests__/peable-provider.test.ts',
    'src/services/payments/stripe/__tests__/stripe-provider.test.ts',
    'src/services/referrals/__tests__/link-token.test.ts',
    'src/services/referrals/__tests__/redirect-destination.test.ts',
    'src/services/referrals/__tests__/referral-state.test.ts',
    'src/services/reviews/__tests__/review-media.service.test.ts',
  ],
  // `vi.stubGlobal`, `vi.stubEnv`, `vi.unstubAllGlobals`, `vi.unstubAllEnvs`.
  'global and environment stubs (vi.stubGlobal / vi.stubEnv)': [
    'src/db/__tests__/deployCoverage.test.ts',
    'src/middleware/__tests__/commerce-actor.test.ts',
    'src/services/__tests__/fx.service.test.ts',
    'src/services/digital/__tests__/digital-byte-source.test.ts',
  ],
  'expect.soft': [
    'src/services/__tests__/merchandising-category-isolation.test.ts',
    'src/services/catalog-authoring/__tests__/authoring-validation.test.ts',
    'src/services/catalog-proposals/__tests__/catalog-proposal-isolation.test.ts',
  ],
  // bun:test hands `toSatisfy` the pending promise instead of the rejection
  // reason. review.service also uses `toHaveBeenCalledExactlyOnceWith`.
  '`.rejects.toSatisfy(…)`': [
    'src/services/__tests__/address.service.test.ts',
    'src/services/__tests__/catalog-write.rollup.test.ts',
    'src/services/__tests__/collection.service.test.ts',
    'src/services/__tests__/draft-order.service.test.ts',
    'src/services/__tests__/favorite.service.test.ts',
    'src/services/__tests__/feedback.service.test.ts',
    'src/services/__tests__/inventory-level.service.test.ts',
    'src/services/__tests__/inventory.service.test.ts',
    'src/services/__tests__/refund.service.test.ts',
    'src/services/__tests__/review.service.test.ts',
    'src/services/__tests__/store.service.test.ts',
    'src/services/reviews/__tests__/review-eligibility.test.ts',
    'src/services/reviews/__tests__/review-migration.test.ts',
    'src/services/reviews/__tests__/review-self-review.test.ts',
  ],
  // `it.each([…, ['a', 'b'], …])`: bun:test spreads an array ROW into separate
  // arguments, so the case receives `'a'` instead of the array it is about.
  'it.each spreads an array row': [
    'src/middleware/__tests__/buyer-order-views.test.ts',
    'src/services/reviews/__tests__/review-list-query.test.ts',
  ],
};

if (!process.versions.bun) {
  console.error('test-bun: run this with bun (`bun run test:bun`); it runs the suite on that bun.');
  process.exit(1);
}

const IGNORED = ['**/*.realdb.test.ts', ...Object.values(EXCLUDED).flat()];

// A renamed or deleted file must leave this list in the same change, or the
// list silently stops meaning what it says.
const stale = Object.values(EXCLUDED)
  .flat()
  .filter((path) => !existsSync(join(PACKAGE_ROOT, path)));
if (stale.length > 0) {
  console.error(`test-bun: excluded files that no longer exist:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}

await setup();
let code = 1;
try {
  // `process.execPath` is the bun running this script, so the suite runs on
  // exactly that Bun.
  const child = spawn(
    process.execPath,
    [
      'test',
      '--isolate',
      // vitest.config.ts's testTimeout.
      '--timeout',
      '30000',
      ...IGNORED.map((pattern) => `--path-ignore-patterns=${pattern}`),
      ...process.argv.slice(2),
      'src',
      'scripts',
    ],
    { cwd: PACKAGE_ROOT, env: process.env, stdio: 'inherit' },
  );
  code = await new Promise<number>((resolve) => {
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
} finally {
  await teardown();
}
process.exit(code);
