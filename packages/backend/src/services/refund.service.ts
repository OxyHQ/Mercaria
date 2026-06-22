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

import type {
  Money,
  Refund as RefundDTO,
  RefundLineItem,
  CreateRefundInput,
} from '@mercaria/shared-types';
import { Refund, type IRefund, type IRefundLineItem } from '../models/refund.js';
import { Order, type IOrder, type IOrderItem } from '../models/order.js';
import { nextRmaNumber } from '../models/counter.js';
import { restock } from './inventory.service.js';
import { decrementOnRefund } from './customer.service.js';
import { sumMoney, roundMinorUnits } from '../utils/money.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Mongo duplicate-key error code (a unique-index violation). */
const MONGO_DUPLICATE_KEY = 11000;
/** Status note recorded on the order when a refund leaves some amount refundable. */
const PARTIAL_REFUND_NOTE = 'partial refund';
/** Status note recorded on the order when a refund covers the grand total. */
const FULL_REFUND_NOTE = 'refund';

/** True iff `err` is a Mongo duplicate-key (unique-index) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/** Map a persisted `{ amount, currency }` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/** Map a persisted refund line item to its DTO (omit absent optionals). */
function toLineItemDTO(line: IRefundLineItem): RefundLineItem {
  const dto: RefundLineItem = {
    variantId: line.variantId,
    quantity: line.quantity,
    amount: toMoney(line.amount),
    restock: line.restock,
  };
  if (line.locationId) dto.locationId = line.locationId;
  return dto;
}

/** Serialize a refund document to the `Refund` DTO (omit absent optionals). */
export function toRefundDTO(refund: IRefund): RefundDTO {
  const dto: RefundDTO = {
    id: String((refund as { _id: unknown })._id),
    orderId: refund.orderId,
    type: refund.type,
    status: refund.status,
    lineItems: refund.lineItems.map(toLineItemDTO),
    totalRefunded: toMoney(refund.totalRefunded),
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
  if (refund.storeId) dto.storeId = refund.storeId;
  if (refund.sellerOxyUserId) dto.sellerOxyUserId = refund.sellerOxyUserId;
  if (refund.reason) dto.reason = refund.reason;
  if (refund.refundShipping) dto.refundShipping = toMoney(refund.refundShipping);
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
    const existing = await Refund.findOne({ idempotencyKey: input.idempotencyKey }).lean<
      IRefund | null
    >();
    if (existing) {
      return toRefundDTO(existing);
    }
  }

  // 2. Load the order (scoped to the store) and validate it is refundable.
  const order = await Order.findById(orderId).lean<IOrder | null>();
  if (!order || order.storeId !== storeId) {
    throw notFound('Order not found');
  }
  if (order.payment.status !== 'paid') {
    throw conflict('Order is not paid');
  }
  if (order.status === 'refunded') {
    throw conflict('Order is already fully refunded');
  }

  // 3. Index order items by variantId (one line per variant).
  const itemByVariant = new Map<string, IOrderItem>();
  for (const item of order.items) {
    itemByVariant.set(item.variantId, item);
  }

  // 4. Cumulative over-refund guard: sum prior refunded quantity per variant.
  const priorRefunds = await Refund.find({ orderId }).lean<IRefund[]>();
  const priorRefundedQty = new Map<string, number>();
  for (const prior of priorRefunds) {
    for (const line of prior.lineItems) {
      priorRefundedQty.set(line.variantId, (priorRefundedQty.get(line.variantId) ?? 0) + line.quantity);
    }
  }

  const currency = order.totals.grandTotal.currency as Money['currency'];

  // 5. Compute each line's refundable amount from the DISCOUNTED net.
  const computedLines: IRefundLineItem[] = input.lineItems.map((inputLine) => {
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

    // Net line value paid = unitPrice * orderedQty - lineDiscount; refund the
    // proportional share for `requestedQty` units (half-even rounded).
    const discountTotalAmount = item.discountTotal?.amount ?? 0;
    const netLineAmount = item.unitPrice.amount * orderedQty - discountTotalAmount;
    const lineAmount = roundMinorUnits((netLineAmount * requestedQty) / orderedQty);

    const line: IRefundLineItem = {
      variantId: inputLine.variantId,
      quantity: requestedQty,
      amount: { amount: lineAmount, currency: item.unitPrice.currency },
      restock: inputLine.restock ?? false,
    };
    const locationId = inputLine.locationId ?? item.locationId;
    if (locationId !== undefined) {
      line.locationId = locationId;
    }
    return line;
  });

  // 6. Optionally refund shipping (the order's persisted shipping cost).
  const refundShipping = input.refundShipping === true ? toMoney(order.shipping.cost) : undefined;

  // 7. Total refunded = every line amount (+ shipping when included).
  const lineAmounts = computedLines.map((line) => toMoney(line.amount));
  const totalRefunded = sumMoney(
    refundShipping ? [...lineAmounts, refundShipping] : lineAmounts,
    currency,
  );

  // 8. Restock explicitly per-line (NEVER via transition). Track if any happened.
  let anyRestock = false;
  for (const line of computedLines) {
    if (line.restock) {
      await restock(line.variantId, line.quantity, line.locationId);
      anyRestock = true;
    }
  }

  // 9. Create the immutable Refund doc; converge on a concurrent idempotent dup.
  let created: IRefund;
  try {
    const doc = await Refund.create({
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
    created = doc.toObject();
  } catch (err) {
    if (isDuplicateKeyError(err) && input.idempotencyKey) {
      const converged = await Refund.findOne({ idempotencyKey: input.idempotencyKey }).lean<
        IRefund | null
      >();
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
  // refunds cover the grand total; else partial (payment stays 'paid').
  const cumulativeRefunded = priorRefunds.reduce(
    (acc, prior) => acc + prior.totalRefunded.amount,
    totalRefunded.amount,
  );
  const isFullyRefunded = cumulativeRefunded >= order.totals.grandTotal.amount;
  if (isFullyRefunded) {
    await Order.findOneAndUpdate(
      { _id: orderId },
      {
        $set: { status: 'refunded', 'payment.status': 'refunded' },
        $push: {
          statusHistory: {
            status: 'refunded',
            at: new Date(),
            byOxyUserId: actorOxyUserId,
            note: FULL_REFUND_NOTE,
          },
        },
      },
    );
  } else {
    await Order.findOneAndUpdate(
      { _id: orderId },
      {
        $set: { status: 'partially_refunded' },
        $push: {
          statusHistory: {
            status: 'partially_refunded',
            at: new Date(),
            byOxyUserId: actorOxyUserId,
            note: PARTIAL_REFUND_NOTE,
          },
        },
      },
    );
  }

  // 11. Decrement the related store customer's lifetime spend (store orders only).
  if (order.sellerType === 'store' && order.storeId && order.buyerOxyUserId) {
    await decrementOnRefund(order.storeId, order.buyerOxyUserId, totalRefunded);
  }

  return toRefundDTO(created);
}

/** List an order's refunds at the store (newest first), or empty. */
export async function listForOrder(storeId: string, orderId: string): Promise<RefundDTO[]> {
  const refunds = await Refund.find({ orderId, storeId })
    .sort({ createdAt: -1 })
    .lean<IRefund[]>();
  return refunds.map(toRefundDTO);
}

/** Load one refund scoped to its store, or throw NOT_FOUND. */
export async function getById(storeId: string, id: string): Promise<RefundDTO> {
  const refund = await Refund.findOne({ _id: id, storeId }).lean<IRefund | null>();
  if (!refund) {
    throw notFound('Refund not found');
  }
  return toRefundDTO(refund);
}
