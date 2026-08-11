/**
 * ADR 0004 D9.1's progress vocabulary (#129 order rule 4).
 *
 * The ADR states the rule in one sentence and it is the whole reason this
 * function exists: *customer-facing copy may call an order "confirmed" only
 * after every PO under it is accepted; between charge and acceptance the
 * truthful state is "payment received — we are confirming availability with our
 * fulfilment partner"*. So the `paid` case is not one row in a table of eight —
 * it is the case the table was written for, and the test that matters is the
 * one asserting `paid` does NOT read as confirmed.
 */

import { describe, expect, it } from 'vitest';
import { RETAIL_ORDER_PROGRESS_STAGES, type OrderStatus } from '@mercaria/shared-types';
// The order-status tuple lives in the SCHEMA, not in shared-types — it is what
// `orders_status_check` is rendered from, so it is the authority a totality
// assertion has to iterate.
import { ORDER_STATUSES } from '../../../db/schema/orders';
import { deriveRetailOrderProgressStage } from '../retail-order.service';

describe('deriveRetailOrderProgressStage', () => {
  it('a PAID order is confirming availability and is never confirmed (ADR 0004 D9.1)', () => {
    expect(
      deriveRetailOrderProgressStage({ orderStatus: 'paid', paymentStatus: 'paid' }),
    ).toBe('confirming_availability');
  });

  it('only PROCESSING reads as confirmed, because D9.2 binds it to PO acceptance', () => {
    expect(
      deriveRetailOrderProgressStage({ orderStatus: 'processing', paymentStatus: 'paid' }),
    ).toBe('confirmed');
    // The discriminating case: every status BEFORE `processing` must resolve to
    // something other than `confirmed`, or the ADR's prohibition is decorative.
    const beforeProcessing: OrderStatus[] = ['pending_payment', 'paid'];
    for (const orderStatus of beforeProcessing) {
      expect(deriveRetailOrderProgressStage({ orderStatus, paymentStatus: 'paid' })).not.toBe(
        'confirmed',
      );
    }
  });

  it('a pending order whose payment already FAILED is not left waiting', () => {
    // The one case the order status alone cannot answer. Without it a buyer
    // whose card was declined watches "Waiting for payment" forever.
    expect(
      deriveRetailOrderProgressStage({ orderStatus: 'pending_payment', paymentStatus: 'failed' }),
    ).toBe('cancelled');
    expect(
      deriveRetailOrderProgressStage({ orderStatus: 'pending_payment', paymentStatus: 'unpaid' }),
    ).toBe('awaiting_payment');
  });

  it('a PARTIAL refund is its own stage and is not reported as fully refunded', () => {
    // Collapsing it onto `refunded` would tell a buyer the whole order came
    // back when part of it may still be on its way.
    expect(
      deriveRetailOrderProgressStage({
        orderStatus: 'partially_refunded',
        paymentStatus: 'refunded',
      }),
    ).toBe('partially_refunded');
    expect(
      deriveRetailOrderProgressStage({ orderStatus: 'refunded', paymentStatus: 'refunded' }),
    ).toBe('refunded');
  });

  it('is TOTAL over the order status vocabulary', () => {
    // A status added to `ORDER_STATUSES` without a stage would fall out of the
    // switch as `undefined` and render as a blank timeline. The floor stops a
    // broken import passing this by iterating nothing.
    expect(ORDER_STATUSES.length).toBeGreaterThanOrEqual(8);
    const stages = new Set<string>(RETAIL_ORDER_PROGRESS_STAGES);
    for (const orderStatus of ORDER_STATUSES) {
      const stage = deriveRetailOrderProgressStage({ orderStatus, paymentStatus: 'paid' });
      expect(stages.has(stage), `${orderStatus} produced the unknown stage ${stage}`).toBe(true);
    }
  });
});
