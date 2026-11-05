/**
 * The live NO-MONEY check of every plan on sale (runbook step 5): for each
 * active paid version's every price, create a Peable Checkout Session in
 * `mode: 'subscription'` exactly as a merchant's checkout would, confirm its
 * hosted page opens (HTTP 200), then EXPIRE it — so nothing can ever be paid on
 * it. Run as Mercaria's workload against the live merchant, it proves the
 * Orbit prices, the routing and the hosted page without a card.
 *
 * The probe customer is one Peable customer, created once under a stable key
 * and labelled as the probe; it is never bound to a store.
 */

import type { Peable } from '@peable.to/sdk';
import type { Database } from '../../db/postgres.js';
import {
  listActiveMerchantPlans,
  listMerchantPlanPrices,
} from '../../db/merchantPlans/planRepository.js';

export type CheckoutProbeClient = Pick<Peable, 'customers' | 'checkout'>;

export interface CheckoutProbeResult {
  planKey: string;
  version: number;
  interval: string;
  currency: string;
  providerPriceId: string;
  sessionId: string | null;
  pageStatus: number | null;
  expired: boolean;
  error?: string;
}

export async function probePlanCheckouts(
  client: CheckoutProbeClient,
  db: Database,
  options: {
    livemode: boolean;
    returnUrl: string;
    /** Injected for tests; the real page is fetched over the network. */
    fetchPage?: (url: string) => Promise<number>;
    /** Distinguishes one probe run's idempotency keys from another's. */
    runId: string;
  },
): Promise<CheckoutProbeResult[]> {
  const fetchPage =
    options.fetchPage ?? (async (url: string) => (await fetch(url, { redirect: 'follow' })).status);
  const customer = await client.customers.create(
    {
      name: 'Mercaria plan checkout probe',
      metadata: { purpose: 'mercaria-plan-sale-probe' },
    },
    { idempotencyKey: 'mercaria-plan-sale-probe-customer' },
  );

  const plans = (await listActiveMerchantPlans(db)).filter((plan) => plan.tier === 'paid');
  const prices = await listMerchantPlanPrices(db, {
    planIds: plans.map((plan) => plan.id),
    livemode: options.livemode,
  });
  const results: CheckoutProbeResult[] = [];
  for (const price of prices) {
    const plan = plans.find((candidate) => candidate.id === price.planId);
    if (!plan) continue;
    const result: CheckoutProbeResult = {
      planKey: plan.planKey,
      version: plan.version,
      interval: price.interval,
      currency: price.unitPriceCurrency,
      providerPriceId: price.providerPriceId,
      sessionId: null,
      pageStatus: null,
      expired: false,
    };
    try {
      const session = await client.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: customer.id,
          line_items: [{ price: price.providerPriceId, quantity: 1 }],
          success_url: options.returnUrl,
          cancel_url: options.returnUrl,
          metadata: { purpose: 'mercaria-plan-sale-probe', plan_id: plan.id },
        },
        { idempotencyKey: `mercaria-plan-probe:${options.runId}:${price.providerPriceId}` },
      );
      result.sessionId = session.id;
      try {
        if (session.url) result.pageStatus = await fetchPage(session.url);
      } finally {
        // ALWAYS expire, whatever the page answered: a probe session must
        // never stay payable.
        const expired = await client.checkout.sessions.expire(session.id, undefined, {
          idempotencyKey: `mercaria-plan-probe-expire:${session.id}`,
        });
        result.expired = expired.status === 'expired';
      }
    } catch (error) {
      result.error =
        error instanceof Error ? `${error.constructor.name}: ${error.message}` : 'error';
    }
    results.push(result);
  }
  return results;
}
