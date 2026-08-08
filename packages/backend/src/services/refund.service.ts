/**
 * Refund service — process money refunds/returns against a paid Order (B6).
 *
 * `process` is the SOLE authority for refund-driven inventory restock: it computes
 * each line's refundable amount from the order item's DISCOUNTED net (never gross),
 * restocks the requested units EXPLICITLY per-line via `inventory.restock`, creates
 * an immutable `Refund` doc (with an RMA number), and sets the order's status
 * DIRECTLY (`partially_refunded` while some amount remains refundable, `refunded`
 * once cumulative refunds cover the grand total) — it NEVER calls
 * `order.service.transition`, so it can never double-restock. A cumulative
 * over-refund (across all prior refunds) is a CONFLICT. For store orders with a
 * related buyer it decrements the customer's lifetime `totalSpent`. The
 * sparse-unique `idempotencyKey` short-circuits a replayed submit. Every operation
 * is scoped to its `storeId`, so a member only ever refunds their own store's orders.
 *
 * ## The commerce decision commits BEFORE the money moves, and that is ADR 0001 D7
 *
 * Everything above is the commerce record and it is authoritative for WHAT is
 * refundable. When the order was paid through a rail that settled its seller,
 * `process` additionally commits a `payment_refunded` outbox row in the same
 * transaction, and `services/payments/refund-execution.service.ts` is what then
 * returns the buyer's money and recovers the seller's share.
 *
 * Two consequences follow and both are deliberate:
 *
 *  - **A rail being slow or unreachable cannot refuse a refund a merchant
 *    authorised.** The record commits, the stock is back, the order has moved,
 *    and the money follows with retries behind it.
 *  - **A refund is `refunded` here while its money is still `pending` there.**
 *    Those are two different facts about one refund — the commerce lifecycle and
 *    the money's own — and the DTO carries both so a merchant screen can tell
 *    them apart rather than being told a buyer has been paid when they have not.
 *
 * Nothing in the provider path ever touches inventory. Restock happens exactly
 * once, here, from the lines the merchant approved (#49 invariant 2), and a
 * provider outcome arriving days later — a refund that failed at the issuer, a
 * reversal that could not be made — changes no stock at all.
 */

import {
  assertSafeMoneyAmount,
  type CurrencyCode,
  type DualMoney,
  type Refund as RefundDTO,
  type RefundLineItem,
  type CreateRefundInput,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  findRefundByIdempotencyKey,
  findRefundById,
  findRefundInStore,
  findRefundsForOrderInStore,
  insertRefund,
  nextRmaNumber,
  sumRefundedQuantities,
  sumRefundedShopAmount,
  type NewRefundLineItem,
  type RefundLineItemRow,
  type RefundRecord,
} from '../db/orders/refundRepository.js';
import {
  findOrderById,
  setOrderStatus,
  type OrderItemRecord,
} from '../db/orders/orderRepository.js';
import { getDb } from '../db/postgres.js';
import { restock } from './inventory.service.js';
import { decrementOnRefund } from './customer.service.js';
import { paymentRefundedEventId, enqueuePaymentEvent } from './payments/payment-outbox.service.js';
import { refundGoesThroughProvider } from './payments/refund-execution.service.js';
import { sumMoney, roundMinorUnits } from '../utils/money.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Status note recorded on the order when a refund leaves some amount refundable. */
const PARTIAL_REFUND_NOTE = 'partial refund';
/** Status note recorded on the order when a refund covers the grand total. */
const FULL_REFUND_NOTE = 'refund';

/** The four columns of a `DualMoney`, reassembled. */
function dual(
  shopAmount: number,
  shopCurrency: CurrencyCode,
  presentmentAmount: number,
  presentmentCurrency: CurrencyCode,
): DualMoney {
  return {
    shop: { amount: shopAmount, currency: shopCurrency },
    presentment: { amount: presentmentAmount, currency: presentmentCurrency },
  };
}

/** Map a persisted refund line item to its DTO (omit absent optionals). */
function toLineItemDTO(line: RefundLineItemRow): RefundLineItem {
  const dto: RefundLineItem = {
    variantId: line.variantId,
    quantity: line.quantity,
    amount: dual(
      line.amountShopAmount,
      line.amountShopCurrency,
      line.amountPresentmentAmount,
      line.amountPresentmentCurrency,
    ),
    restock: line.restock,
  };
  if (line.locationId) dto.locationId = line.locationId;
  return dto;
}

/** Serialize a refund record to the `Refund` DTO (omit absent optionals). */
export function toRefundDTO(refund: RefundRecord): RefundDTO {
  const dto: RefundDTO = {
    id: refund.id,
    orderId: refund.orderId,
    type: refund.type,
    status: refund.status,
    lineItems: refund.lineItems.map(toLineItemDTO),
    totalRefunded: dual(
      refund.totalRefundedShopAmount,
      refund.totalRefundedShopCurrency,
      refund.totalRefundedPresentmentAmount,
      refund.totalRefundedPresentmentCurrency,
    ),
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
  if (refund.storeId) dto.storeId = refund.storeId;
  if (refund.sellerOxyUserId) dto.sellerOxyUserId = refund.sellerOxyUserId;
  if (refund.reason) dto.reason = refund.reason;
  // All four columns are present or absent together
  // (`refunds_refund_shipping_complete_check`).
  if (
    refund.refundShippingShopAmount !== null &&
    refund.refundShippingShopCurrency !== null &&
    refund.refundShippingPresentmentAmount !== null &&
    refund.refundShippingPresentmentCurrency !== null
  ) {
    dto.refundShipping = dual(
      refund.refundShippingShopAmount,
      refund.refundShippingShopCurrency,
      refund.refundShippingPresentmentAmount,
      refund.refundShippingPresentmentCurrency,
    );
  }
  if (refund.rmaNumber) dto.rmaNumber = refund.rmaNumber;
  if (refund.restockedAt) dto.restockedAt = refund.restockedAt.toISOString();
  if (refund.processedByOxyUserId) dto.processedByOxyUserId = refund.processedByOxyUserId;
  // The MERCHANT-safe slice of the provider operation: which rail, where the
  // money got to, and a failure CODE. Named field by field rather than spread,
  // like every other projection here, so a column added later cannot ride along.
  //
  // What is deliberately absent is everything that identifies the movement at
  // the rail or describes Mercaria's own recovery — `providerRefundId`,
  // `providerReversalId`, `reversalState` and the reversal amount. A merchant
  // needs to know whether their buyer has been paid; whether Mercaria has
  // finished clawing the seller's share back off a connected account is an
  // operator's reconciliation question and belongs to the payment trace (#50).
  if (refund.provider) dto.provider = refund.provider;
  if (refund.providerState) dto.providerState = refund.providerState;
  if (refund.providerFailureCode) dto.providerFailureCode = refund.providerFailureCode;
  return dto;
}

/**
 * Process a refund/return against a paid order (scoped to `storeId`).
 *
 * Idempotent on `input.idempotencyKey`: a replayed submit returns the prior
 * refund without re-restocking or re-creating. Computes each line's refundable
 * amount from the order item's DISCOUNTED net, caps the cumulative refunded
 * quantity at the ordered quantity, restocks each line explicitly, creates the
 * `Refund` doc, sets the order status directly (`partially_refunded`/`refunded`),
 * and decrements the related store customer's lifetime spend.
 */
export async function process(
  storeId: string,
  orderId: string,
  input: CreateRefundInput,
  actorOxyUserId: string,
): Promise<RefundDTO> {
  // 1. Idempotency short-circuit: a replayed submit returns the prior refund.
  if (input.idempotencyKey) {
    const existing = await findRefundByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return toRefundDTO(existing);
    }
  }

  // 2. Load the order (scoped to the store) and validate it is refundable.
  const order = await findOrderById(orderId);
  if (!order || order.storeId !== storeId) {
    throw notFound('Order not found');
  }
  if (order.paymentStatus !== 'paid') {
    throw conflict('Order is not paid');
  }
  if (order.status === 'refunded') {
    throw conflict('Order is already fully refunded');
  }

  // 3. Index order items by variantId (one line per variant).
  const itemByVariant = new Map<string, OrderItemRecord>();
  for (const item of order.items) {
    itemByVariant.set(item.variantId, item);
  }

  // 4. Cumulative over-refund guard: prior refunded quantity per variant, summed
  // in SQL over EVERY refunded unit — whether or not it was restocked, which is a
  // different question the repository answers separately.
  const priorRefundedQty = await sumRefundedQuantities(orderId);

  const shopCurrency = order.totalsGrandTotalShopCurrency;
  const presentmentCurrency = order.totalsGrandTotalPresentmentCurrency;

  // The discounted-net refundable amount for `requestedQty` units on ONE currency
  // side (unitPrice * orderedQty − lineDiscount, prorated + half-even rounded).
  // The proration is the one place a refund forms a NEW amount rather than
  // copying a stored one, so its result is asserted representable here.
  const sideAmount = (
    unitAmount: number,
    discountAmount: number | null,
    orderedQty: number,
    requestedQty: number,
    side: 'shop' | 'presentment',
  ): number => {
    const net = unitAmount * orderedQty - (discountAmount ?? 0);
    const prorated = roundMinorUnits((net * requestedQty) / orderedQty);
    assertSafeMoneyAmount(prorated, `refund.lineAmount.${side}`);
    return prorated;
  };

  // 5. Compute each line's refundable amount from the DISCOUNTED net, on BOTH the
  // shop (merchant accounting) and presentment (what the buyer paid) sides.
  const computedLines: NewRefundLineItem[] = input.lineItems.map((inputLine) => {
    const item = itemByVariant.get(inputLine.variantId);
    if (!item) {
      throw validationError('Refund line variant not in order');
    }
    const orderedQty = item.quantity;
    const requestedQty = inputLine.quantity;
    const alreadyRefunded = priorRefundedQty.get(inputLine.variantId) ?? 0;
    if (alreadyRefunded + requestedQty > orderedQty) {
      throw conflict('Cumulative refund quantity exceeds ordered quantity');
    }

    const line: NewRefundLineItem = {
      variantId: inputLine.variantId,
      quantity: requestedQty,
      amount: {
        shop: {
          amount: sideAmount(
            item.unitPriceShopAmount,
            item.discountTotalShopAmount,
            orderedQty,
            requestedQty,
            'shop',
          ),
          currency: item.unitPriceShopCurrency,
        },
        presentment: {
          amount: sideAmount(
            item.unitPricePresentmentAmount,
            item.discountTotalPresentmentAmount,
            orderedQty,
            requestedQty,
            'presentment',
          ),
          currency: item.unitPricePresentmentCurrency,
        },
      },
      restock: inputLine.restock ?? false,
    };
    const locationId = inputLine.locationId ?? item.locationId ?? undefined;
    if (locationId !== undefined) {
      line.locationId = locationId;
    }
    return line;
  });

  // 6. Optionally refund shipping (the order's persisted dual shipping cost).
  const refundShipping =
    input.refundShipping === true
      ? dual(
          order.shippingCostShopAmount,
          order.shippingCostShopCurrency,
          order.shippingCostPresentmentAmount,
          order.shippingCostPresentmentCurrency,
        )
      : undefined;

  // 7. Total refunded = every line amount (+ shipping when included), on each side.
  const shopParts = computedLines.map((line) => line.amount.shop);
  const presentmentParts = computedLines.map((line) => line.amount.presentment);
  const totalRefunded: DualMoney = {
    shop: sumMoney(refundShipping ? [...shopParts, refundShipping.shop] : shopParts, shopCurrency),
    presentment: sumMoney(
      refundShipping ? [...presentmentParts, refundShipping.presentment] : presentmentParts,
      presentmentCurrency,
    ),
  };

  // 8. Restock explicitly per-line (NEVER via transition). Track if any happened.
  let anyRestock = false;
  for (const line of computedLines) {
    if (line.restock) {
      await restock(line.variantId, line.quantity, line.locationId);
      anyRestock = true;
    }
  }

  const db = getDb();

  // The RMA number is drawn BEFORE the transaction below, and deliberately: it
  // comes from a Postgres SEQUENCE, which is non-transactional by design, so
  // drawing it inside would burn a number on every rollback without making it
  // reusable. Outside, a rolled-back refund costs one gap in a printed number
  // rather than a transaction that has to be retried around a side effect it
  // cannot undo.
  const rmaNumber = await nextRmaNumber();

  // 9. Decide whether this refund has a MONEY movement to make, and at which
  // rail. A payment Mercaria recorded rather than made — cash in a register, or
  // an order captured on Shopify — is refunded wherever it was captured, so it
  // gets no provider operation and the row says so by leaving `provider` NULL
  // (#49 scope 9). The rail must also be one that settled the seller, because a
  // buyer refund with no way to recover the seller's share is exactly the half
  // of ADR 0001 D7 that must not ship alone.
  const providerOperation =
    order.paymentId && order.paymentProvider && refundGoesThroughProvider(order.paymentProvider)
      ? { provider: order.paymentProvider, paymentId: order.paymentId }
      : undefined;

  // 10. Create the immutable refund + its lines and — when there is money to
  // move — the durable promise that it will move, in ONE transaction. Converge
  // on a concurrent idempotent duplicate.
  //
  // The outbox row commits WITH the refund because the two are one decision: a
  // refund whose provider call lived in this request would evaporate on a
  // restart, and by then the inventory above has already been restocked. The row
  // IS the job, exactly as it is for a payment's own consequences.
  let created: RefundRecord;
  try {
    created = await db.transaction(async (tx) => {
      const refund = await insertRefund(
        {
          orderId,
          ...(order.storeId ? { storeId: order.storeId } : {}),
          ...(order.sellerOxyUserId ? { sellerOxyUserId: order.sellerOxyUserId } : {}),
          type: input.type ?? 'refund',
          status: 'refunded',
          ...(input.reason ? { reason: input.reason } : {}),
          lineItems: computedLines,
          ...(refundShipping ? { refundShipping } : {}),
          totalRefunded,
          ...(anyRestock ? { restockedAt: new Date() } : {}),
          processedByOxyUserId: actorOxyUserId,
          rmaNumber,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(providerOperation ? { providerOperation } : {}),
        },
        tx,
      );
      if (providerOperation) {
        await enqueuePaymentEvent(tx, {
          id: paymentRefundedEventId(refund.id),
          eventType: 'payment_refunded',
          payload: {
            refundId: refund.id,
            orderId,
            paymentId: providerOperation.paymentId,
          },
        });
      }
      return refund;
    });
  } catch (err) {
    // The NAMED index, so a duplicate on any other constraint stays a real
    // failure rather than silently returning someone else's refund.
    if (isUniqueViolation(err, 'refunds_idempotency_key_key') && input.idempotencyKey) {
      const converged = await findRefundByIdempotencyKey(input.idempotencyKey);
      if (converged) {
        log.general.warn(
          { orderId, storeId },
          'Concurrent/replayed refund detected; converging on prior refund',
        );
        return toRefundDTO(converged);
      }
    }
    throw err;
  }

  // 11. Set the order status DIRECTLY (no transition). Full when cumulative
  // refunds cover the grand total; else partial (payment stays 'paid'). Compared
  // on the SHOP (merchant accounting) side — the single-currency refund basis,
  // summed in SQL now that this refund's own row is committed.
  //
  // It moves on the COMMERCE record and not on the rail's answer, which is the
  // semantics issue #49 invariant 3 asks about: the merchant approved these
  // lines, the units are back on the shelf, and the order is what the buyer and
  // the seller both read. A provider-pending refund therefore does NOT hold the
  // order at `paid` — the money's own state is tracked beside it, on the refund,
  // and that is what a screen distinguishing pending from completed reads.
  const cumulativeRefunded = await sumRefundedShopAmount(orderId);
  const isFullyRefunded = cumulativeRefunded >= order.totalsGrandTotalShopAmount;
  await setOrderStatus(
    orderId,
    isFullyRefunded ? 'refunded' : 'partially_refunded',
    isFullyRefunded ? { paymentStatus: 'refunded' } : {},
    {
      status: isFullyRefunded ? 'refunded' : 'partially_refunded',
      at: new Date(),
      byOxyUserId: actorOxyUserId,
      note: isFullyRefunded ? FULL_REFUND_NOTE : PARTIAL_REFUND_NOTE,
    },
  );

  // 12. Decrement the related store customer's lifetime spend (store orders only),
  // in the store's SHOP currency (mirrors the shop-money upsertOnPaid bump).
  if (order.sellerType === 'store' && order.storeId && order.buyerOxyUserId) {
    await decrementOnRefund(order.storeId, order.buyerOxyUserId, totalRefunded.shop);
  }

  // 13. Move the money now rather than at the next poll, by draining the row
  // just committed. It claims the SAME lease the dispatcher would, so the two
  // can never both run it, and if this task dies first the poller picks it up —
  // the identical shape `applyPaymentStatus` uses for a payment's consequences.
  //
  // The refund is re-read afterwards so the caller sees the provider state the
  // drain produced; if the drain failed, that state is still `pending`, which is
  // the honest answer rather than an error on a refund that is genuinely
  // recorded and genuinely on its way.
  if (providerOperation) {
    await drainRefundExecution(paymentRefundedEventId(created.id));
    const settled = await findRefundById(created.id);
    if (settled) return toRefundDTO(settled);
  }

  return toRefundDTO(created);
}

/**
 * Run the refund's own outbox row, without letting its failure fail the refund.
 *
 * The refund is committed, the stock is back and the order has moved. If the
 * rail is unreachable the row is released with backoff and the dispatcher
 * retries it — so re-throwing here would answer a merchant with a 500 for a
 * refund that is recorded, correct and simply not yet paid out, and the most
 * likely next thing they would do is submit it again.
 */
async function drainRefundExecution(eventId: string): Promise<void> {
  const { drainPaymentOutbox } = await import('./payments/payment-outbox.service.js');
  const { runPaymentOutboxEvent } = await import('./payments/outbox-handlers.js');
  try {
    await drainPaymentOutbox({ handler: runPaymentOutboxEvent, eventId });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, eventId },
      '[Payments] inline refund execution failed; the dispatcher will retry',
    );
  }
}

/** List an order's refunds at the store (newest first), or empty. */
export async function listForOrder(storeId: string, orderId: string): Promise<RefundDTO[]> {
  const refunds = await findRefundsForOrderInStore(storeId, orderId);
  return refunds.map(toRefundDTO);
}

/** Load one refund scoped to its store, or throw NOT_FOUND. */
export async function getById(storeId: string, id: string): Promise<RefundDTO> {
  const refund = await findRefundInStore(storeId, id);
  if (!refund) {
    throw notFound('Refund not found');
  }
  return toRefundDTO(refund);
}
