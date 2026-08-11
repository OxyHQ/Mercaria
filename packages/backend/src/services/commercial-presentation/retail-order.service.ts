/**
 * What a buyer is told about a placed Mercaria-retail order (#129
 * §"Order and receipt", ADR 0004 D9.1; #126's `#162/#129` seam).
 *
 * Three facts, from three places that already hold them, and none of them
 * re-derived here:
 *
 *  - **Who sold it and under what terms** — `retail_order_role_snapshots`, the
 *    immutable record #126 wrote inside the order's own transaction. Never
 *    today's configuration: a receipt reprinted next year has to say what the
 *    buyer bought under, which is #129 order rule 9's reasoning applied to the
 *    terms as well as to the seller.
 *  - **Where it has got to** — the ORDER's own status, mapped to D9.1's
 *    customer language by {@link deriveRetailOrderProgressStage}.
 *  - **When it is expected** — #126's promise trail, accepted and current kept
 *    SEPARATE.
 *
 * Nothing here reads a purchase order, a supplier, a procurement intent or a
 * cost. That is not squeamishness about a join: those rows carry the supplier's
 * identity and Mercaria's wholesale position, and a projection that loaded them
 * "to be safe" is one field away from serving them. The order status already
 * answers the buyer's question, because D9.2 binds `processing` to every
 * purchase order being accepted — so the acceptance fact reaches this surface
 * through a column that carries nothing else.
 */

import type {
  OrderPaymentStatus,
  OrderStatus,
  RetailDeliveryStatement,
  RetailOrderExperience,
  RetailOrderProgressStage,
} from '@mercaria/shared-types';
import { findRetailOrderRoleSnapshot } from '../../db/retailFulfilment/retailFulfilmentRepository';
import {
  readRetailDeliveryPromiseView,
  type RetailDeliveryPromiseStatement,
} from '../retail-fulfilment/delivery-promise.service';
import { retailPresentationFromSnapshot } from './presentation';

/**
 * ADR 0004 D9.1, as a total function of the order's own two status columns.
 *
 * The `paid` case is the one the ADR wrote this vocabulary for: between the
 * charge and every purchase order being accepted the truthful state is
 * *"payment received — we are confirming availability with our fulfilment
 * partner"*, and calling it `confirmed` there is the specific thing D9.1
 * forbids. `processing` maps to `confirmed` because D9.2's retail binding is
 * that a retail order enters `processing` ONLY on purchase-order acceptance —
 * so the acceptance is what the column already means.
 *
 * `paymentStatus` is read only for the one case the order status cannot answer:
 * an order sitting at `pending_payment` whose payment has already failed is not
 * waiting for anything, and telling a buyer it is would leave them watching a
 * screen that will never move.
 */
export function deriveRetailOrderProgressStage(input: {
  orderStatus: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}): RetailOrderProgressStage {
  switch (input.orderStatus) {
    case 'pending_payment':
      return input.paymentStatus === 'failed' ? 'cancelled' : 'awaiting_payment';
    case 'paid':
      return 'confirming_availability';
    case 'processing':
      return 'confirmed';
    case 'shipped':
      return 'on_the_way';
    case 'delivered':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'refunded':
      return 'refunded';
  }
}

/**
 * #126's promise statement, minus what a buyer may not see.
 *
 * `sourceRef` is dropped rather than filtered downstream: it is a supplier
 * quote id or a Moovo transport id and sits in `PROTECTED_COLUMNS`, and the
 * projection naming every field it emits is the `provider_accounts` device —
 * a field added to the promise later cannot arrive here by accident.
 */
function toDeliveryStatement(statement: RetailDeliveryPromiseStatement): RetailDeliveryStatement {
  const projected: RetailDeliveryStatement = {
    basis: statement.basis,
    observedAt: statement.observedAt,
    stale: statement.stale,
  };
  if (statement.earliestAt) projected.earliestAt = statement.earliestAt;
  if (statement.latestAt) projected.latestAt = statement.latestAt;
  return projected;
}

/** What one placed retail order's buyer surface renders. */
export interface ReadRetailOrderExperienceInput {
  orderId: string;
  orderStatus: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  now?: Date;
}

/**
 * The buyer's view of one retail order, or `null` when the order has no role
 * snapshot.
 *
 * `null` rather than a fabricated presentation, and the distinction matters:
 * every order placed through #123 gets its snapshot in the same transaction, so
 * a retail order without one is an order from before #126 landed or a
 * consistency fault — and answering it with today's terms would tell a buyer
 * they agreed to windows that did not exist when they paid. The caller renders
 * the ordinary order surface instead.
 */
export async function readRetailOrderExperience(
  input: ReadRetailOrderExperienceInput,
): Promise<RetailOrderExperience | null> {
  const now = input.now ?? new Date();
  const snapshot = await findRetailOrderRoleSnapshot(input.orderId);
  if (!snapshot) return null;

  const promises = await readRetailDeliveryPromiseView(input.orderId, now);
  const experience: RetailOrderExperience = {
    commercial: retailPresentationFromSnapshot(snapshot),
    stage: deriveRetailOrderProgressStage({
      orderStatus: input.orderStatus,
      paymentStatus: input.paymentStatus,
    }),
    // A failed refresh is its OWN fact, beside the two estimates rather than
    // folded into either (#126 rule 9). A surface showing only the newest
    // observed window would be confidently precise about a figure whose refresh
    // has been failing for a day. The reason CODE is not carried: it is
    // operator vocabulary, and #126 already forbids provider text reaching a
    // buyer.
    refreshFailing: promises.lastRefreshFailure !== undefined,
  };
  if (promises.accepted) experience.acceptedDelivery = toDeliveryStatement(promises.accepted);
  if (promises.current) experience.currentDelivery = toDeliveryStatement(promises.current);
  return experience;
}
