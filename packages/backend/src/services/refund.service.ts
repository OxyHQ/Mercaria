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
import { restock } from './inventory.service.js';
import { decrementOnRefund } from './customer.service.js';
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

  // 9. Create the immutable refund + its lines in ONE transaction; converge on a
  // concurrent idempotent duplicate.
  let created: RefundRecord;
  try {
    created = await insertRefund({
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
      rmaNumber: await nextRmaNumber(),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
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

  // 10. Set the order status DIRECTLY (no transition). Full when cumulative
  // refunds cover the grand total; else partial (payment stays 'paid'). Compared
  // on the SHOP (merchant accounting) side — the single-currency refund basis,
  // summed in SQL now that this refund's own row is committed.
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

  // 11. Decrement the related store customer's lifetime spend (store orders only),
  // in the store's SHOP currency (mirrors the shop-money upsertOnPaid bump).
  if (order.sellerType === 'store' && order.storeId && order.buyerOxyUserId) {
    await decrementOnRefund(order.storeId, order.buyerOxyUserId, totalRefunded.shop);
  }

  return toRefundDTO(created);
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
