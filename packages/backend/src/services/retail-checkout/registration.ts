/**
 * Close #124's two ports (#123, ADR 0004 D4 steps 4–5).
 *
 * ONE function, called once at boot, so the two registrations cannot be made in
 * different places and drift out of step: a deployment holding the
 * authorization reader without the outcome consumer would place supplier orders
 * and never refund a buyer when one was rejected, which is the worst of the
 * four combinations.
 *
 * It is deliberately a separate module from the two implementations. `index.ts`
 * imports it lazily beside every other dispatcher, and a module that only wires
 * has no reason to be reached by anything a test drives — the realdb suites
 * register the readers they need directly, so an import order in production
 * cannot make a test pass that would fail without it.
 */

import { registerRetailOutboxConsumer } from '../payments/retail-outbox.port.js';
import { registerProcurementOutcomeConsumer } from '../supplier-orders/procurement-outcome.port.js';
import { log } from '../../lib/logger.js';
import { registerRetailProcurementAuthorizationReader } from './authorization.js';
import {
  createPurchaseOrderFromIntent,
  createRetailCompensatingRefund,
  recordSupplierAcceptanceVariance,
  requestRetailCompensatingRefund,
  requestRetailProcurement,
} from './fulfilment.service.js';

/**
 * Install the authorization reader and the terminal-outcome consumer.
 *
 * The consumer's two branches are the two halves of ADR 0004's cost story:
 *
 *  - **accepted** — record the variance between what the supplier accepted at
 *    and what the buyer was locked at (D8). It BOOKS nothing; #128 recognizes
 *    it. A failure here is thrown so the announcement's outbox row retries,
 *    because a lost variance record is a surplus that becomes invisible.
 *  - **failed** — enqueue the compensating refund (D4 step 5). Also thrown on
 *    failure, and for a sharper reason: an unrefunded buyer whose item was
 *    never sourced is the one outcome this whole sequence exists to prevent.
 */
export function registerRetailProcurementPorts(): void {
  registerRetailProcurementAuthorizationReader();
  // The payment outbox's two #123 rows. The handler switch stays a switch — the
  // consumer is what it dispatches to, so `services/payments/` never imports
  // the procurement domain (`role-separation.test.ts`, #118 acceptance 8).
  registerRetailOutboxConsumer({
    requestFulfilment: requestRetailProcurement,
    handle: async (event) => {
      const orderId = requiredString(event.payload, 'orderId');
      if (event.eventType === 'procurement_requested') {
        await createPurchaseOrderFromIntent({
          orderId,
          supplierId: requiredString(event.payload, 'supplierId'),
        });
        return;
      }
      await createRetailCompensatingRefund({
        orderId,
        purchaseOrderId: requiredString(event.payload, 'purchaseOrderId'),
      });
    },
  });
  registerProcurementOutcomeConsumer(async (notice) => {
    if (notice.kind === 'accepted') {
      const recorded = await recordSupplierAcceptanceVariance({
        orderId: notice.orderId,
        purchaseOrderId: notice.purchaseOrderId,
        acceptedCostMinor: notice.acceptedCostMinor,
      });
      log.general.info(
        { purchaseOrderId: notice.purchaseOrderId, recorded },
        '[Retail] supplier acceptance observed against the locked amount',
      );
      return;
    }
    await requestRetailCompensatingRefund({
      orderId: notice.orderId,
      purchaseOrderId: notice.purchaseOrderId,
      kind: notice.failure,
      detail: notice.detail,
    });
  });
  log.general.info(
    {},
    '[Retail] authorization, outbox and outcome ports registered (#123 closing #124)',
  );
}

/** One required string off an outbox payload, or a loud failure. */
function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`A retail outbox row carries no ${key}.`);
  }
  return value;
}
