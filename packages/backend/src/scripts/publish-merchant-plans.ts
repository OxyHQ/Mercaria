/**
 * Publish the reviewed merchant plan catalogue (`services/billing/plan-catalogue.ts`)
 * — Orbit products, prices and features on Mercaria's Peable merchant, then the
 * Mercaria plan versions bound to them (#89).
 *
 *   bun packages/backend/dist/scripts/publish-merchant-plans.js --merchant=merch_… [--apply]
 *
 * Runs as a one-shot ECS task on the live task definition (it needs Mercaria's
 * workload identity for Peable and the production database), dispatched by
 * `.github/workflows/publish-merchant-plans.yml`. Preview (the default) reads
 * only and prints the actions it would take. It never turns billing on: what
 * sells is `MERCHANT_BILLING_ENABLED`, a separate reviewed change.
 */

import { config } from '../config/index.js';
import { closePostgres, connectPostgres } from '../db/postgres.js';
import { createPeableClient } from '../services/payments/peable/client.js';
import { PeableError } from '@peable.to/sdk';
import {
  CatalogueDrift,
  syncMerchantPlanCatalogue,
} from '../services/billing/plan-catalogue-sync.js';

async function main() {
  let apply = false;
  let merchantId = '';
  let actor = 'owner-decision:2026-11-05';
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') apply = true;
    else if (arg === '--preview') apply = false;
    else if (/^--merchant=merch_[A-Za-z0-9]+$/.test(arg))
      merchantId = arg.slice('--merchant='.length);
    else if (/^--actor=[A-Za-z0-9:._@-]{3,120}$/.test(arg)) actor = arg.slice('--actor='.length);
    else throw new Error(`Unknown or invalid argument: ${arg.split('=')[0]}`);
  }
  if (!merchantId) throw new Error('--merchant=merch_… is required');

  const db = await connectPostgres();
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
