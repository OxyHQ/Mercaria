/**
 * Publish the reviewed merchant plan catalogue (`services/billing/plan-catalogue.ts`)
 * — Orbit products, prices and features on Mercaria's Peable merchant, then the
 * Mercaria plan versions bound to them (#89).
 *
 *   bun packages/backend/dist/scripts/publish-merchant-plans.js --merchant=merch_… [--apply | --probe]
 *
 * Runs as a one-shot ECS task on the live task definition (it needs Mercaria's
 * workload identity for Peable and the production database), dispatched by
 * `.github/workflows/publish-merchant-plans.yml`. Preview (the default) reads
 * only and prints the actions it would take. `--probe` is the live NO-MONEY
 * check: one subscription Checkout Session per published price, its hosted page
 * fetched, then expired (`plan-checkout-probe.ts`). None of the three turns
 * billing on: what sells is `MERCHANT_BILLING_ENABLED`, a separate change.
 */

import { config } from '../config/index.js';
import { closePostgres, connectPostgres } from '../db/postgres.js';
import { createPeableClient } from '../services/payments/peable/client.js';
import { probePlanCheckouts } from '../services/billing/plan-checkout-probe.js';
import { PeableError } from '@peable.to/sdk';
import {
  CatalogueDrift,
  syncMerchantPlanCatalogue,
} from '../services/billing/plan-catalogue-sync.js';

async function main() {
  let apply = false;
  let probe = false;
  let merchantId = '';
  let actor = 'owner-decision:2026-11-05';
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') apply = true;
    else if (arg === '--preview') apply = false;
    else if (arg === '--probe') probe = true;
    else if (/^--merchant=merch_[A-Za-z0-9]+$/.test(arg))
      merchantId = arg.slice('--merchant='.length);
    else if (/^--actor=[A-Za-z0-9:._@-]{3,120}$/.test(arg)) actor = arg.slice('--actor='.length);
    else throw new Error(`Unknown or invalid argument: ${arg.split('=')[0]}`);
  }
  if (!merchantId) throw new Error('--merchant=merch_… is required');

  const db = await connectPostgres();
  if (probe) {
    const returnUrl = config.merchantBilling.returnUrl;
    if (!returnUrl) throw new Error('MERCHANT_BILLING_RETURN_URL is not set on this task');
    const merchant = await createPeableClient().merchants.retrieve();
    if (merchant.id !== merchantId)
      throw new Error('The workload is not the expected Peable merchant');
    const results = await probePlanCheckouts(createPeableClient(), db, {
      livemode: config.payments.peable.livemode,
      returnUrl,
      runId: new Date().toISOString().replace(/[^0-9]/g, ''),
    });
    process.stdout.write(`${JSON.stringify({ probe: true, results }, null, 2)}\n`);
    if (results.length === 0 || results.some((r) => r.pageStatus !== 200 || !r.expired)) {
      process.exitCode = 1;
    }
    return;
  }
  const result = await syncMerchantPlanCatalogue(createPeableClient(), db, {
    merchantId,
    livemode: config.payments.peable.livemode,
    apply,
    actor,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    // A catalogue refusal names the row and the reason; a database or gateway
    // error could carry a connection string, so only its class is printed.
    const message =
      error instanceof CatalogueDrift
        ? error.message
        : error instanceof PeableError
          ? `Peable refused: ${error.code ?? 'error'} ${error.message}`
          : `failed (${error instanceof Error ? error.constructor.name : typeof error})`;
    process.stderr.write(`publish-merchant-plans: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(closePostgres);
