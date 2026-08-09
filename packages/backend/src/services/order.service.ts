/**
 * Order service — order lifecycle transitions, queries, and store stats.
 *
 * `transition` is the single gate for moving an order between statuses: it
 * enforces the allowed-transition graph and runs the matching inventory effect
 * via `inventory.service` (commit on pay; restock vs release on cancel/refund
 * depending on whether stock was already committed). It NEVER copies aggregate
 * counts — seller `salesCount` moves ±1 in lockstep with real paid orders.
 *
 * Order DTOs are built ONLY through `order-hydration.service`; this service loads
 * the right rows and delegates serialization.
 */

import type {
  CurrencyCode,
  Money,
  Order as OrderDTO,
  OrderStatus,
  OrderSummary,
} from '@mercaria/shared-types';
import {
  findOrderMatching,
  findOrdersPage,
  countOrdersByStatus,
  sumPaidRevenue,
  transitionOrderStatus,
  type NewOrderStatusEvent,
  type OrderListFilter,
  type OrderRecord,
  type OrderTransitionPatch,
} from '../db/orders/orderRepository.js';
import { sumRestockedQuantities } from '../db/orders/refundRepository.js';
import { countLowStockVariantsForStore } from '../db/catalog/variantRepository.js';
import { adjustSellerSalesCount } from '../db/buyers/sellerProfileRepository.js';
import { adjustStoreSalesCount, findStoreRow } from '../db/stores/storeRepository.js';
import { commit, release, restock } from './inventory.service.js';
import { upsertOnPaid as upsertCustomerOnPaid } from './customer.service.js';
import { grantEligibilitiesForOrder } from './reviews/review-eligibility.service.js';
import { hydrateOrders, summarizeOrders } from './order-hydration.service.js';
import { enqueueOrderEvent, enqueueFulfillmentPush } from '../queue/producers.js';
import type { OrderEvent } from '../queue/types.js';
import { zeroMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * The allowed status transitions. A transition NOT listed under the current
 * status is a CONFLICT. `cancelled`/`refunded` are terminal.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled', 'refunded', 'partially_refunded'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
};

/**
 * Map a transitioned-to status to the buyer/seller notification event, or
 * `undefined` when the status has no notification (e.g. `processing`,
 * `refunded`). Drives the best-effort order-event enqueue at the end of
 * `transition`.
 */
const STATUS_TO_EVENT: Partial<Record<OrderStatus, OrderEvent>> = {
  paid: 'paid',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** Options for a `transition` call. */
interface TransitionOptions {
  /** Oxy user id of the actor driving the transition (recorded in history). */
  actorOxyUserId?: string;
  /** Optional free-text note recorded on the status event. */
  note?: string;
  /** Tracking number to attach (e.g. when moving to `shipped`). */
  trackingNumber?: string;
}

/** The order's grand total on the SHOP (merchant accounting) side. */
function shopGrandTotal(order: OrderRecord): Money {
  return {
    amount: order.totalsGrandTotalShopAmount,
    currency: order.totalsGrandTotalShopCurrency,
  };
}

/**
 * Transition an order to `next`, enforcing the allowed-transition graph and
 * running the matching inventory effect:
 *   - `paid`: commit every line (sale finalized) + bump the seller's salesCount.
 *   - `cancelled`/`refunded`: per line, RESTOCK if already paid (stock was
 *     committed) else RELEASE the reservation; `refunded` also marks payment
 *     refunded.
 *
 * The status flip is an atomic compare-and-swap (`UPDATE … WHERE id = $1 AND
 * status = $2 RETURNING`), executed BEFORE any inventory/salesCount side-effects.
 * Only the winning caller (whose CAS matched the pre-transition status) runs the
 * side-effects, so a buyer `cancel` racing the expire-reservations sweep — or any
 * multi-process double-invoke — runs them AT MOST ONCE: the loser matches no row
 * and throws CONFLICT before touching inventory.
 *
 * @returns The order as persisted, with the new status event appended — the
 *   caller hydrates that rather than re-reading.
 */
export async function transition(
  order: OrderRecord,
  next: OrderStatus,
  opts: TransitionOptions,
): Promise<OrderRecord> {
  const current = order.status;
  if (!TRANSITIONS[current].includes(next)) {
    throw conflict(`Cannot transition order from ${current} to ${next}`);
  }

  /**
   * A moderation freeze outranks the transition graph.
   *
   * This is what makes a `freeze_transaction` decision real: restricting a
   * listing stops NEW orders, but an order placed yesterday would otherwise be
   * paid, packed and shipped while its case is still open. The check sits here,
   * above the CAS, because `transition` is the single gate every lifecycle move
   * goes through — guarding the callers instead would leave the next one added
   * unguarded.
   *
   * `cancelled` is deliberately still reachable. A freeze exists to stop goods and
   * money moving FORWARD, and refusing to let a frozen order be cancelled would
   * trap a buyer's funds in exactly the transaction a jury is questioning.
   */
  if (order.moderationHold === true && next !== 'cancelled') {
    throw conflict(
      `Order ${order.id} is held pending a moderation decision and cannot ` +
        `move to ${next}.`,
    );
  }

  // The pre-transition payment state drives restock-vs-release on cancel/refund.
  const wasPaid = order.paymentStatus === 'paid';

  // Build the status event + any payment/shipping columns BEFORE the CAS.
  const event: NewOrderStatusEvent = {
    status: next,
    at: new Date(),
    ...(opts.actorOxyUserId ? { byOxyUserId: opts.actorOxyUserId } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };

  /**
   * `paid` records that the order was paid and NOTHING about how the money
   * settles. There is deliberately no currency conversion here: an order priced
   * in EUR reaches `paid` with no rate for any other currency available, which
   * is what lets Mercaria sell in fiat before any particular rail exists. The
   * facts a payment produces — provider, captured amount, the platform-currency
   * conversion and its rate snapshot — belong to the payment domain, which owns
   * them per payment rather than per order status flip.
   */
  const patch: OrderTransitionPatch = {
    ...(opts.trackingNumber ? { shippingTrackingNumber: opts.trackingNumber } : {}),
  };
  if (next === 'paid') {
    patch.paymentStatus = 'paid';
    patch.paymentPaidAt = new Date();
  } else if (next === 'refunded') {
    patch.paymentStatus = 'refunded';
  }

  // Atomic CAS gate: only succeeds if the order is still at `current`.
  const updated = await transitionOrderStatus(order.id, current, next, patch, event);
  if (!updated) {
    throw conflict(`Order ${order.id} was concurrently transitioned`);
  }

  // CAS won — run the inventory side-effects + salesCount bump exactly once.
  // Each line commits/releases/restocks at its own `locationId` when set (POS
  // sales reserve at the register location); storefront items carry none and
  // resolve the store's default location, unchanged.
  if (next === 'paid') {
    for (const item of order.items) {
      await commit(item.variantId, item.quantity, item.locationId ?? undefined);
    }
    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      await adjustSellerSalesCount(order.sellerOxyUserId, 1);
    } else if (order.sellerType === 'store' && order.storeId) {
      await adjustStoreSalesCount(order.storeId, 1);
      // Relate the store buyer + bump their lifetime aggregates (exactly once).
      if (order.buyerOxyUserId) {
        // Customer lifetime spend aggregates in the store's SHOP currency.
        await upsertCustomerOnPaid(order.storeId, order.buyerOxyUserId, shopGrandTotal(order));
      }
    }

    /**
     * #76: a completed native order earns review eligibility for the product,
     * the merchant and the transaction. Granted HERE because `paid` is the
     * first moment Mercaria knows the goods were bought, and idempotent because
     * `UNIQUE(order_item_id, oxy_user_id, scope)` converges a redelivery.
     *
     * Best-effort, deliberately: the order is paid whether or not this runs, so
     * a failure must not fail the transition and re-enter this whole block.
     * The grant is re-run by any later call (an operator repair, a re-delivery),
     * and until then the buyer sees no review prompt — which is a delay, not a
     * wrong number.
     */
    try {
      await grantEligibilitiesForOrder(order.id);
    } catch (err) {
      log.general.warn(
        { err, orderId: order.id },
        'Review eligibility grant failed after payment (best-effort)',
      );
    }
  } else if (next === 'cancelled' || next === 'refunded') {
    if (wasPaid) {
      // A `refund.service` refund may have ALREADY restocked some units per-line.
      // Subtract those so a later full cancel/refund restocks only the remainder
      // — never the units a refund already returned (no double-restock). Summed
      // in SQL over the RESTOCKED lines only, which is a different question from
      // "how much has been refunded"; see the refund repository.
      const restockedQtyByVariant = await sumRestockedQuantities(order.id);
      for (const item of order.items) {
        const alreadyRestocked = restockedQtyByVariant.get(item.variantId) ?? 0;
        const remainingQty = Math.max(0, item.quantity - alreadyRestocked);
        if (remainingQty > 0) {
          await restock(item.variantId, remainingQty, item.locationId ?? undefined);
        }
      }
    } else {
      for (const item of order.items) {
        await release(item.variantId, item.quantity, item.locationId ?? undefined);
      }
    }
  }

  log.general.info(
    { orderId: order.id, status: next, actor: opts.actorOxyUserId },
    'Order transitioned',
  );

  // Best-effort: notify buyer + seller of the lifecycle change. `processing`
  // has no buyer-facing event, so it is skipped. A notification failure must
  // never fail the transition.
  const orderEvent = STATUS_TO_EVENT[next];
  if (orderEvent) {
    try {
      await enqueueOrderEvent({ orderId: order.id, event: orderEvent });
    } catch (err) {
      log.general.warn(
        { err, orderId: order.id, status: next },
        'Failed to enqueue order-event notification',
      );
    }
  }

  // Fulfillment push: when a MERCHANT ships a connector order (one carrying
  // `source`), push the fulfillment back to its origin platform. Only this
  // merchant-driven path reaches `transition`; the inbound sync sets status via a
  // direct update and never calls `transition`, so a platform-originated
  // fulfillment cannot echo back out (the service also gates on the connection
  // being `orders: bidirectional`). Best-effort — never fails the transition.
  if (next === 'shipped' && order.sourceExternalId !== null) {
    try {
      await enqueueFulfillmentPush({ orderId: order.id });
    } catch (err) {
      log.general.warn({ err, orderId: order.id }, 'Failed to enqueue fulfillment push');
    }
  }

  // Return the PERSISTED row with the new event appended, so a caller that
  // hydrates the result sees exactly what the database now holds — the Mongo path
  // mutated the in-memory document for the same reason.
  return {
    ...updated.order,
    items: order.items,
    appliedDiscounts: order.appliedDiscounts,
    taxLines: order.taxLines,
    statusHistory: [...order.statusHistory, updated.event],
  };
}

/** Load an order by ownership filter (for mutation), or throw NOT_FOUND. */
async function loadOrder(filter: OrderListFilter & { id: string }): Promise<OrderRecord> {
  const order = await findOrderMatching(filter);
  if (!order) {
    throw notFound('Order not found');
  }
  return order;
}

/** A page of order summaries plus the total matching count (controller paginates). */
interface OrderPage {
  data: OrderSummary[];
  total: number;
}

/** Offset-paginated list parameters. */
interface ListParams {
  page: number;
  limit: number;
  status?: OrderStatus;
}

/** List the buyer's own orders (newest first), summarized + total count. */
export async function getBuyerOrders(
  oxyUserId: string,
  { page, limit }: ListParams,
): Promise<OrderPage> {
  const { rows, total } = await findOrdersPage({ buyerOxyUserId: oxyUserId }, page, limit);
  return { data: await summarizeOrders(rows), total };
}

/** Get a single order owned by the buyer (hydrated), or throw NOT_FOUND. */
export async function getOrderForBuyer(oxyUserId: string, id: string): Promise<OrderDTO> {
  return hydrateOne(await loadOrder({ id, buyerOxyUserId: oxyUserId }));
}

/** List a P2P seller's orders (optionally filtered by status), summarized. */
export async function getSellerOrders(
  oxyUserId: string,
  { status, page, limit }: ListParams,
): Promise<OrderPage> {
  const { rows, total } = await findOrdersPage(
    { sellerOxyUserId: oxyUserId, ...(status ? { status } : {}) },
    page,
    limit,
  );
  return { data: await summarizeOrders(rows), total };
}

/** List a store's orders (optionally filtered by status), summarized. */
export async function getStoreOrders(
  storeId: string,
  { status, page, limit }: ListParams,
): Promise<OrderPage> {
  const { rows, total } = await findOrdersPage(
    { storeId, ...(status ? { status } : {}) },
    page,
    limit,
  );
  return { data: await summarizeOrders(rows), total };
}

/** Get a single order owned by the store (hydrated), or throw NOT_FOUND. */
export async function getOrderForStore(storeId: string, id: string): Promise<OrderDTO> {
  return hydrateOne(await loadOrder({ id, storeId }));
}

/** Hydrate one order record into its DTO, or throw NOT_FOUND. */
async function hydrateOne(order: OrderRecord): Promise<OrderDTO> {
  const [dto] = await hydrateOrders([order]);
  if (!dto) {
    throw notFound('Order not found');
  }
  return dto;
}

/**
 * Dev-only mock pay: fund the order's whole CHECKOUT GROUP through the synthetic
 * payment rail. 404s (hidden) when the mock-pay endpoint is disabled
 * (production).
 *
 * ## It pays the group, not the order, and that is not a widening for its own sake
 *
 * ADR 0001 D4 makes funding atomic at the group level — one payment covers a
 * multi-seller cart and its sibling orders cannot have different funding
 * outcomes. A dev seam that paid one order of a group would be the only path in
 * the system able to produce a state the real one cannot, which makes it useless
 * for exercising the real one.
 *
 * ## It goes through the provider, rather than around it
 *
 * `createPayment` then `capture` against `SyntheticPaymentProvider`, and the
 * resulting status is applied through `applyPaymentStatus` like any other. So
 * every developer running mock-pay exercises the adapter interface, the state
 * machine, the ledger postings and the outbox — the same code a real rail will
 * run — instead of a shortcut that proves nothing about them.
 */
export async function mockPay(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  if (!config.orders.mockPayEnabled) {
    throw notFound('Not found');
  }
  const order = await loadOrder({ id: orderId, buyerOxyUserId: oxyUserId });
  const { checkoutGroupId } = order;
  if (!checkoutGroupId) {
    // Every checked-out order is stamped with a group. One without it never came
    // through checkout (a connector import is the only such shape), and paying a
    // group of one by inventing an id would fund an order the real rail cannot.
    throw conflict(`Order ${orderId} has no checkout group and cannot be mock-paid.`);
  }

  const { ensurePayment, applyPaymentStatus } = await import('./payments/payment.service.js');
  const { findOrdersInCheckoutGroup } = await import('./payments/order-linkage.js');
  const { getMockPaymentProvider } = await import('./payments/registry.js');

  // The charge covers the group's grand total in the buyer's presentment
  // currency — the sum of what the buyer was shown for each seller's portion.
  const siblings = await findOrdersInCheckoutGroup(checkoutGroupId);
  const presentmentCurrency = order.totalsGrandTotalPresentmentCurrency;
  const amount = siblings.reduce((total, sibling) => total + sibling.presentmentTotalMinor, 0);

  const payment = await ensurePayment({
    provider: 'mock',
    checkoutGroupId,
    presentment: { amount, currency: presentmentCurrency },
    buyerOxyUserId: oxyUserId,
  });

  const provider = getMockPaymentProvider();
  const created = await provider.createPayment({
    paymentId: payment.id,
    checkoutGroupId,
    amount: { amount, currency: presentmentCurrency },
    orderIds: siblings.map((sibling) => sibling.id),
    idempotencyKey: `pi:${payment.id}`,
    metadata: { paymentId: payment.id, checkoutGroupId },
  });
  const captured = await provider.capture({
    paymentId: payment.id,
    providerObjectId: created.providerObjectId,
    idempotencyKey: `cap:${payment.id}`,
  });

  await applyPaymentStatus({
    paymentId: payment.id,
    next: captured.status,
    providerObjectId: captured.providerObjectId,
  });

  // The paid transition happened through the payment's outbox handler on a
  // freshly loaded record, so the one in hand is stale.
  return hydrateOne(await loadOrder({ id: orderId, buyerOxyUserId: oxyUserId }));
}

/** Cancel the buyer's own order (releases the reservation if still unpaid). */
export async function cancelByBuyer(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  const order = await loadOrder({ id: orderId, buyerOxyUserId: oxyUserId });
  return hydrateOne(
    await transition(order, 'cancelled', {
      actorOxyUserId: oxyUserId,
      note: 'cancelled by buyer',
    }),
  );
}

/** Fulfilment update params for a P2P seller. */
interface SellerFulfilInput {
  status: 'processing' | 'shipped' | 'delivered';
  trackingNumber?: string;
}

/** Advance a P2P seller's order along the fulfilment path (processing/shipped/delivered). */
export async function fulfillSellerOrder(
  oxyUserId: string,
  orderId: string,
  { status, trackingNumber }: SellerFulfilInput,
): Promise<OrderDTO> {
  const order = await loadOrder({ id: orderId, sellerOxyUserId: oxyUserId });
  return hydrateOne(
    await transition(order, status, {
      actorOxyUserId: oxyUserId,
      ...(trackingNumber ? { trackingNumber } : {}),
    }),
  );
}

/** Status-patch params for a store order. */
interface StoreStatusInput {
  status: OrderStatus;
  trackingNumber?: string;
  note?: string;
}

/** Patch a store order's status (any allowed transition; records the actor). */
export async function patchStoreOrderStatus(
  storeId: string,
  orderId: string,
  { status, trackingNumber, note }: StoreStatusInput,
  actorOxyUserId: string,
): Promise<OrderDTO> {
  const order = await loadOrder({ id: orderId, storeId });
  return hydrateOne(
    await transition(order, status, {
      actorOxyUserId,
      ...(trackingNumber ? { trackingNumber } : {}),
      ...(note ? { note } : {}),
    }),
  );
}

/** A store's order dashboard stats. */
interface StoreStats {
  counts: Record<OrderStatus, number>;
  revenue: Money;
  lowStockVariantCount: number;
}

/** Every order status initialized to a zero count. */
function zeroCounts(): Record<OrderStatus, number> {
  return {
    pending_payment: 0,
    paid: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
    partially_refunded: 0,
  };
}

/**
 * Compute a store's order dashboard stats: per-status order counts, paid-order
 * revenue (in the store's default currency), and the number of tracked variants
 * at or below the low-stock threshold.
 *
 * The revenue sum is now SQL, filtered to the store's settlement currency by a
 * real predicate on a real column. The Mongo version loaded EVERY paid order into
 * the process and filtered the mixed-currency ones out in JavaScript, so a store
 * with a hundred thousand paid orders pulled all of them back to produce one
 * number — and it fell back to "whatever currency the first order happened to be
 * in" when the store row was missing, which could report a figure in a currency
 * the store does not settle in. The fallback is FAIR, matching the column default.
 */
export async function storeStats(storeId: string): Promise<StoreStats> {
  const store = await findStoreRow(storeId);
  const currency = (store?.defaultCurrency as CurrencyCode | undefined) ?? 'FAIR';

  const [statusCounts, paid, lowStockVariantCount] = await Promise.all([
    countOrdersByStatus(storeId),
    sumPaidRevenue(storeId, currency),
    countLowStockVariantsForStore(storeId, config.orders.lowStockThreshold),
  ]);

  const counts = zeroCounts();
  for (const [status, n] of statusCounts) {
    counts[status] = n;
  }

  const revenue: Money =
    paid.revenue > 0 ? { amount: paid.revenue, currency } : zeroMoney(currency);

  return { counts, revenue, lowStockVariantCount };
}
