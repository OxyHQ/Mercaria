/**
 * The ONE seam this domain reads orders through — the `order-linkage.ts` shape.
 *
 * Six services need the same seven order facts, and the alternative is six
 * places importing `orderRepository` and each projecting slightly differently.
 * `services/payments/order-linkage.ts` established the pattern for exactly this
 * reason and it applies unchanged: the buyer-request domain reads orders through
 * a projection it OWNS rather than reaching into somebody else's repository from
 * six directions.
 *
 * ## It reads and it does not write
 *
 * There is no exported function here that mutates an order, and
 * `buyer-request-isolation.test.ts` fails the build if this module learns to
 * import `order.service`, `refund.service` or an inventory writer. The DECISION
 * services import those directly and are the only ones that may — which is what
 * keeps the line between "a buyer asked" and "a seller acted" visible in the
 * import graph rather than only in prose.
 *
 * ## The store lookup is one extra read and it is worth it
 *
 * A store's return window is a real merchant setting
 * (`stores.policies_return_window_days`) rather than a constant, so
 * "deadlines snapshotted from policy" (#110 return field 9) means something. A
 * P2P order has no store row and gets the shared default — see
 * `policy.ts`'s `returnWindowDays` for why the default is the generous one.
 */

import type { BuyerOrderRequestOptions } from '@mercaria/shared-types';
import {
  CANCELLATION_REASONS_OFFERING_RETURN,
  RETURN_REASONS_OFFERING_CANCELLATION,
} from '@mercaria/shared-types';
import { findOpenCancellationRequestForOrder } from '../../db/buyerRequests/cancellationRepository.js';
import {
  findOpenReturnRequestForOrder,
  sumReturnedQuantities,
} from '../../db/buyerRequests/returnRepository.js';
import { findOrderById, type OrderRecord } from '../../db/orders/orderRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import {
  orderAccessFactsFromRecord,
  type OrderAccessFacts,
} from '../orders/order-access.service.js';
import {
  cancellationEligibilityWithOpenRequest,
  returnEligibilityWithOpenRequest,
  type BuyerRequestOrderFacts,
} from './policy.js';

/** Everything a buyer-request path may know about an order. */
export interface BuyerRequestOrderContext {
  /** The full row. Held for the decision services, which drive the real ones. */
  readonly order: OrderRecord;
  /** #106's six facts, for `authorizeOrderAccess`. */
  readonly access: OrderAccessFacts;
  /** `policy.ts`'s seven facts, for the eligibility derivation. */
  readonly policy: BuyerRequestOrderFacts;
}

/**
 * Load one order and both projections of it, or `null`.
 *
 * `null` for a missing order rather than a throw, because every caller answers
 * 404 — and the 404 for "no such order" and the 404 for "not yours" must be the
 * same response, which is easier to get right when neither path throws.
 */
export async function loadBuyerRequestOrder(
  orderId: string,
): Promise<BuyerRequestOrderContext | null> {
  const order = await findOrderById(orderId);
  if (!order) return null;

  const store = order.storeId === null ? null : await findStoreById(order.storeId);
  return {
    order,
    access: orderAccessFactsFromRecord(order),
    policy: {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      shippingMethod: order.shippingMethod,
      sourceExternalId: order.sourceExternalId,
      statusHistory: order.statusHistory.map((event) => ({ status: event.status, at: event.at })),
      storeReturnWindowDays: store?.policiesReturnWindowDays ?? null,
    },
  };
}

/**
 * What a buyer may do with this order right now, and the safe reason when they
 * may not.
 *
 * ONE derivation feeding both the storefront's buttons and the submit paths'
 * refusals, because two spellings of "is this cancellable" would eventually
 * disagree — and the visible failure is a button that exists and then 409s.
 * The submit paths re-run it rather than trusting a client that read it, so
 * this is a projection and never an authorization.
 *
 * `supportAvailable` is passed in rather than derived: whether a credential may
 * write into a thread is a SCOPE question, and answering it here would mean
 * this module knowing about grants.
 */
export async function readBuyerOrderRequestOptions(
  context: BuyerRequestOrderContext,
  input: { supportAvailable: boolean },
  now: Date,
): Promise<BuyerOrderRequestOptions> {
  const [openCancellation, openReturn, alreadyReturning] = await Promise.all([
    findOpenCancellationRequestForOrder(context.order.id),
    findOpenReturnRequestForOrder(context.order.id),
    sumReturnedQuantities(context.order.id),
  ]);

  let returnableUnits = 0;
  for (const item of context.order.items) {
    returnableUnits += Math.max(0, item.quantity - (alreadyReturning.get(item.variantId) ?? 0));
  }

  const cancellation = cancellationEligibilityWithOpenRequest(
    context.policy,
    openCancellation !== undefined,
  );
  const returnable = returnEligibilityWithOpenRequest(
    context.policy,
    { hasOpenRequest: openReturn !== undefined, hasReturnableUnits: returnableUnits > 0 },
    now,
  );

  return {
    orderId: context.order.id,
    cancellation:
      cancellation.verdict === 'eligible'
      ? { available: true }
      : {
          available: false,
          reason: cancellation.reason,
          // Rule 6's return offer, as DATA rather than as a sentence in a
          // template — and computed from the return's own eligibility rather
          // than from the reason alone, so a shipped order past its return
          // window does not offer a return that would be refused.
          returnAvailable:
            CANCELLATION_REASONS_OFFERING_RETURN.includes(cancellation.reason) &&
            returnable.verdict === 'eligible',
        },
    return:
      returnable.verdict === 'eligible'
      ? { available: true, windowEndsAt: returnable.windowEndsAt.toISOString() }
      : {
          available: false,
          reason: returnable.reason,
          cancellationAvailable:
            RETURN_REASONS_OFFERING_CANCELLATION.includes(returnable.reason) &&
            cancellation.verdict === 'eligible',
        },
    supportAvailable: input.supportAvailable,
  };
}

/**
 * How many units of each variant the order actually has.
 *
 * The ceiling every requested and every approved quantity is checked against.
 * Read from the ORDER's own immutable lines, never from a catalogue: what was
 * bought is a fact about the purchase and a variant's current state says
 * nothing about it.
 */
export function orderedQuantitiesByVariant(order: OrderRecord): Map<string, number> {
  return new Map(order.items.map((item) => [item.variantId, item.quantity]));
}
