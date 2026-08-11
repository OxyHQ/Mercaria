/**
 * Who sold a PLACED order, batched for an order list or an order page (#129
 * §"Order and receipt", ADR 0004 D9).
 *
 * The mode is not derived here at all — #123 already stored it. `orders`
 * carries `commercial_role`, tied to `seller_type = 'platform'` by the
 * biconditional CHECK `orders_commercial_role_seller_check`, so "was this
 * Mercaria's own sale" is a column and re-deriving it from a binding would be a
 * second answer that could disagree with what the buyer was actually charged
 * under. A binding retired after the sale must not change what a receipt says.
 *
 * `external_referral` and `informational` never produce an order, so they have
 * no branch here and no order shape to occupy — which is why the switch is over
 * `OrderSellerType` rather than over `CommercialMode`.
 */

import type { CommercialPresentation, OrderSellerType } from '@mercaria/shared-types';
import { log } from '../../lib/logger';
import { findRetailOrderRoleSnapshots } from '../../db/retailFulfilment/retailFulfilmentRepository';
import {
  currentRetailPresentation,
  marketplacePresentation,
  retailPresentationFromSnapshot,
} from './presentation';

/** One order, reduced to what its seller disclosure needs. */
export interface OrderCommercialSubject {
  orderId: string;
  sellerType: OrderSellerType;
  /**
   * The seller's public display name, already resolved by the caller.
   *
   * Ignored for a `platform` order, which has no owner column to resolve one
   * from — that is the point of `orders_commercial_role_seller_check`, and
   * passing an empty string there is honest rather than a placeholder.
   */
  sellerLabel: string;
}

/**
 * The commercial presentation for each order, keyed by order id.
 *
 * Role snapshots are read in ONE statement for every `platform` order on the
 * page, so an orders list does not turn into an N+1.
 */
export async function resolveOrderCommercialPresentations(
  subjects: readonly OrderCommercialSubject[],
): Promise<Map<string, CommercialPresentation>> {
  const byOrder = new Map<string, CommercialPresentation>();
  if (subjects.length === 0) return byOrder;

  const platformOrderIds = subjects
    .filter((subject) => subject.sellerType === 'platform')
    .map((subject) => subject.orderId);
  const snapshots = await findRetailOrderRoleSnapshots(platformOrderIds);

  for (const subject of subjects) {
    if (subject.sellerType === 'platform') {
      const snapshot = snapshots.get(subject.orderId);
      if (snapshot) {
        byOrder.set(subject.orderId, retailPresentationFromSnapshot(snapshot));
        continue;
      }
      // Unreachable for anything #123 placed: the snapshot is written in the
      // order's OWN transaction, so an order without one predates #126 or is a
      // consistency fault. Mercaria is still certainly the seller — the CHECK
      // says so — and only the four rights windows are unknowable, so today's
      // are used and the gap is logged rather than the order being rendered
      // with no seller at all.
      log.general.warn(
        { orderId: subject.orderId },
        '[Commercial] platform order has no retail role snapshot; falling back to current terms',
      );
      byOrder.set(subject.orderId, currentRetailPresentation());
      continue;
    }
    byOrder.set(
      subject.orderId,
      marketplacePresentation({
        sellerKind: subject.sellerType === 'store' ? 'store' : 'user',
        sellerLabel: subject.sellerLabel,
      }),
    );
  }
  return byOrder;
}
