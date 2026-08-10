/**
 * The ONE seam this domain reads orders through — the `order-linkage.ts` shape,
 * for the reason #110's own `order-facts.ts` gives: seven services need the same
 * facts, and the alternative is seven places importing `orderRepository` and
 * each projecting slightly differently.
 *
 * ## It reads and it does not write
 *
 * No exported function here mutates an order, and
 * `retail-service-isolation.test.ts` fails the build if this module learns to
 * import `order.service` or an inventory writer. The refund bridge imports what
 * it needs directly and is the only module that may, which keeps the line
 * between "a buyer asked" and "Mercaria acted" visible in the import graph
 * rather than only in prose.
 *
 * ## It reads no supplier fact either
 *
 * `retail_procurement_intents` is one join away and this module deliberately
 * does not make it. The SUPPLIER clock a request carries comes from the request
 * kind and Mercaria's own service policy, not from what a supplier promised —
 * ADR 0004 D8.5 again: the moment a buyer's deadline is a function of a
 * supplier's, the supplier decides the buyer's rights.
 */

import type { CurrencyCode } from '@mercaria/shared-types';
import { findOrderById, type OrderRecord } from '../../db/orders/orderRepository.js';
import { sumRefundedShopAmount } from '../../db/orders/refundRepository.js';
import { findRetailOrderRoleSnapshot } from '../../db/retailFulfilment/retailFulfilmentRepository.js';
import {
  orderAccessFactsFromRecord,
  type OrderAccessFacts,
} from '../orders/order-access.service.js';
import { currentRetailCustomerTerms } from '../retail-fulfilment/customer-terms.js';
import type { RetailOrderClock, RetailTermsSnapshot } from './policy.js';
import type { RetailRefundOrderLine, RetailRefundOrderTotals } from './allocation.js';

/** Everything a retail service-request path may know about an order. */
export interface RetailServiceOrderContext {
  /** The full row. Held for the refund bridge, which is the only writer. */
  readonly order: OrderRecord;
  /** #106's facts, for `authorizeOrderAccess`. */
  readonly access: OrderAccessFacts;
  /** The four consumer windows this purchase was made under (#126). */
  readonly terms: RetailTermsSnapshot;
  /** The market whose statutory rules apply. */
  readonly market: string;
  /** The instants every deadline is anchored on. */
  readonly clock: RetailOrderClock;
  /** Whether the goods have left, read from the HISTORY. */
  readonly dispatched: boolean;
  /** Whether they arrived, read from the HISTORY. */
  readonly delivered: boolean;
}

/** The earliest instant an order reached one status, from the HISTORY. */
function reachedAt(order: OrderRecord, statuses: readonly string[]): Date | null {
  let earliest: Date | null = null;
  for (const event of order.statusHistory) {
    if (!statuses.includes(event.status)) continue;
    if (earliest === null || event.at.getTime() < earliest.getTime()) earliest = event.at;
  }
  return earliest;
}

/**
 * Load one order and everything derived from it, or `null`.
 *
 * `null` for a missing order rather than a throw, because every caller answers
 * 404 — and the 404 for "no such order" and the 404 for "not yours" must be the
 * same response, which is easier to get right when neither path throws.
 *
 * ## The terms come from the SNAPSHOT, and the fallback is stated
 *
 * #126 writes `retail_order_role_snapshots` in the order's own transaction, so
 * every retail order placed since it landed has one. An order that predates it
 * falls back to the terms IN FORCE TODAY, which is the honest available answer
 * and is recorded as such: the request stores the version it used, so a later
 * reader can tell a snapshot-derived deadline from a reconstructed one.
 */
export async function loadRetailServiceOrder(
  orderId: string,
): Promise<RetailServiceOrderContext | null> {
  const order = await findOrderById(orderId);
  if (!order) return null;

  const snapshot = await findRetailOrderRoleSnapshot(orderId);
  const terms: RetailTermsSnapshot =
    snapshot === undefined
      ? currentRetailCustomerTerms()
      : {
          customerTermsVersion: snapshot.customerTermsVersion,
          cancellationWindowHours: snapshot.cancellationWindowHours,
          withdrawalWindowDays: snapshot.withdrawalWindowDays,
          returnWindowDays: snapshot.returnWindowDays,
          warrantyMonths: snapshot.warrantyMonths,
        };

  const dispatchedAt = reachedAt(order, ['shipped']);
  const deliveredAt = reachedAt(order, ['delivered']);
  return {
    order,
    access: orderAccessFactsFromRecord(order),
    terms,
    // The SELLING entity's country, which is the market whose consumer law
    // Mercaria sells under. Not the buyer's destination: a Spanish entity
    // selling to a Spanish consumer applies Spanish law, and Mercaria has one
    // selling entity today (ADR 0004 D9.9). When it has two this becomes a
    // choice with a rule behind it rather than a column read.
    market: snapshot?.sellerLegalEntityCountry ?? 'ES',
    clock: { placedAt: order.createdAt, dispatchedAt, deliveredAt },
    dispatched: dispatchedAt !== null,
    delivered: deliveredAt !== null,
  };
}

/**
 * The order's lines and totals as the refund allocation reads them.
 *
 * PRESENTMENT amounts throughout, because that is what the buyer paid and what a
 * refund returns to their card. `alreadyRefundedMinor` is the SHOP-side sum
 * `refund.service` maintains; on a retail order the two sides are the same
 * currency (a `platform` order's shop currency IS its presentment currency,
 * since there is no connected seller with an accounting currency of their own),
 * so no conversion happens here and none may be added — a scanned gate asserts
 * this module imports no FX service.
 */
export async function readRetailRefundBasis(order: OrderRecord): Promise<{
  lines: RetailRefundOrderLine[];
  totals: RetailRefundOrderTotals;
}> {
  const currency = order.totalsGrandTotalPresentmentCurrency as CurrencyCode;
  const alreadyRefundedMinor = await sumRefundedShopAmount(order.id);
  return {
    lines: order.items.map((item) => ({
      orderItemId: item.id,
      quantity: item.quantity,
      lineTotalMinor: item.lineTotalPresentmentAmount,
      discountTotalMinor: item.discountTotalPresentmentAmount ?? 0,
      // Tax is an ORDER-level breakdown in this schema (`order_tax_lines`), not
      // a per-line column, so a line's share is not knowable from the line. It
      // is reported as zero rather than apportioned: apportioning it would be a
      // second tax engine, and a wrong one, sitting in the refund path.
      taxMinor: 0,
    })),
    totals: {
      currency,
      deliveryMinor: order.shippingCostPresentmentAmount,
      alreadyRefundedMinor,
      grandTotalMinor: order.totalsGrandTotalPresentmentAmount,
    },
  };
}
