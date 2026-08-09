/**
 * Procurement, triggered by payment state and by nothing else (#123, ADR 0004
 * D4 steps 4–5).
 *
 * Two directions, and keeping them separate is the whole file:
 *
 *  - **Payment → procurement.** A `mercaria_retail` order reaching `paid`
 *    enqueues one `procurement_requested` row per supplier, whose handler turns
 *    the durable intent checkout froze into a PurchaseOrder through #124's
 *    idempotent orchestration.
 *  - **Procurement → refund.** A DEFINITIVE procurement failure enqueues one
 *    `retail_procurement_failed` row, whose handler creates the compensating
 *    refund through #49's existing domain.
 *
 * ADR 0004 D4 chose immediate capture precisely so the second direction is a
 * refund rather than a new money-movement primitive: "any design that would
 * have required new money-movement primitives was rejected for exactly that
 * reason". Nothing here moves money — `refund.service` decides what is
 * refundable and commits it, and `refund-execution.service` calls the rail from
 * its own outbox row, unchanged.
 *
 * ## Why the trigger is an outbox row and not a call from the paid transition
 *
 * The paid transition runs inside the payment outbox handler, in a transaction
 * that also settles transfers. A supplier call there would put an outbound
 * request with a multi-second timeout inside the path that marks a buyer's
 * order paid — and a task restart mid-call would leave a paid order nobody ever
 * procured, with nothing durable saying so. The row IS the job, which is the
 * same reasoning `payment_refunded` already carries.
 *
 * ## Neither direction reads a feature flag, and a gate asserts it
 *
 * `MERCARIA_RETAIL_ENABLED` gates checkout ENTRY (ADR 0004 D4 concern 13). A
 * rollback must leave in-flight procurement, refunds and reconciliation
 * draining, so `retail-checkout-isolation.test.ts` fails the build if this
 * module learns to read `config.retail`. The per-supplier kill switch is a
 * DIFFERENT mechanism and lives where #124 put it (`supplier_accounts.state`),
 * which stops NEW submissions while everything already placed carries on.
 */

import type { CurrencyCode, RetailProcurementFailureKind } from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../../db/postgres.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { insertRefund, type NewRefundLineItem } from '../../db/orders/refundRepository.js';
import {
  attachRetailIntentPurchaseOrder,
  findRetailProcurementIntent,
  listRetailProcurementIntentLines,
  listRetailProcurementIntents,
  markRetailIntentFailed,
  markRetailIntentRequested,
  recordRetailCostVariance,
  type RetailProcurementIntentRecord,
} from '../../db/retailCheckout/retailCheckoutRepository.js';
import { conflict } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { createPurchaseOrderForOrder } from '../procurement/purchase-order.service.js';
import {
  enqueueProcurementEvent,
  purchaseOrderSubmissionEventId,
} from '../supplier-orders/procurement-outbox.service.js';
import { enqueuePaymentEvent, paymentRefundedEventId } from '../payments/payment-outbox.service.js';

/**
 * `payment:procurement_requested:<orderId>:<supplierId>` — ADR 0004 D4 step 4's
 * `po:<orderId>:<supplierId>`, in the payment outbox's own namespace.
 *
 * The pair is the id because ADR 0004 D5 puts ONE PurchaseOrder under each
 * supplier of one retail order, and because that same pair is what
 * `derivePurchaseOrderIdempotencyKey` derives the purchase order's own key
 * from. Three mechanisms keyed on one pair — this row, that key, and
 * `retail_procurement_intents_order_supplier_key` — is what makes a redelivered
 * success, a reclaimed lease and an operator retry converge on ONE purchase
 * order instead of three.
 */
export function procurementRequestedEventId(orderId: string, supplierId: string): string {
  return `payment:procurement_requested:${orderId}:${supplierId}`;
}

/**
 * `payment:retail_procurement_failed:<purchaseOrderId>`.
 *
 * Keyed on the PURCHASE ORDER and never on the delivery that reported the
 * failure. A supplier's rejection can be delivered twice, polled after being
 * webhooked, and re-derived by a reconciliation sweep; all three describe one
 * failed procurement, and a refund per delivery would return the buyer's money
 * more than once.
 */
export function retailProcurementFailedEventId(purchaseOrderId: string): string {
  return `payment:retail_procurement_failed:${purchaseOrderId}`;
}

/**
 * A retail order reached `paid`: request procurement for every supplier it
 * names.
 *
 * Called from `handlePaymentSucceeded` AFTER the paid transitions, so the
 * authorization reader — which requires the order to be `paid` — answers yes by
 * the time #124 asks. Ordering it the other way would make every first
 * submission attempt fail its own authorization check and retry.
 *
 * A non-retail order produces no rows and costs one indexed read. The read is
 * unconditional rather than gated on the group's composition, because a mixed
 * group's retail order sits beside marketplace siblings and skipping the read
 * would need a second answer to "is any of this retail".
 */
export async function requestRetailProcurement(orderIds: readonly string[]): Promise<number> {
  let enqueued = 0;
  for (const orderId of orderIds) {
    const intents = await listRetailProcurementIntents(orderId);
    for (const intent of intents) {
      // Only a `recorded` intent is requested. A `requested` one already has
      // its row, a `purchase_order_created` one already has its purchase order,
      // and a `failed` or `cancelled` one is somebody's decision — none of them
      // wants a second trigger, and the CAS is what makes a redelivered
      // `payment_succeeded` a no-op rather than a duplicate.
      if (intent.status !== 'recorded') continue;
      const claimed = await markRetailIntentRequested({ id: intent.id });
      if (!claimed) continue;

      await enqueuePaymentEvent(getDb(), {
        id: procurementRequestedEventId(intent.orderId, intent.supplierId),
        eventType: 'procurement_requested',
        payload: {
          orderId: intent.orderId,
          supplierId: intent.supplierId,
          intentId: intent.id,
          checkoutGroupId: intent.checkoutGroupId,
        },
      });
      enqueued += 1;
    }
  }
  if (enqueued > 0) {
    log.general.info({ orders: orderIds.length, enqueued }, '[Retail] procurement requested');
  }
  return enqueued;
}

/**
 * Turn ONE frozen intent into a PurchaseOrder and hand it to #124.
 *
 * Everything the purchase order is composed from comes off the intent and its
 * lines. Nothing is re-read from a procurement offer, a policy version or an
 * agreement — the buyer's amount is frozen, so procuring against anything but
 * the frozen inputs is how a locked amount and an actual cost stop describing
 * the same purchase (ADR 0004 D4 step 1's freeze, honoured at the far end).
 *
 * `createPurchaseOrderForOrder` is idempotent on
 * `po:<orderId>:<supplierId>`, so a retry after a lost response converges on
 * the purchase order that already exists rather than creating a second one.
 */
export async function createPurchaseOrderFromIntent(input: {
  orderId: string;
  supplierId: string;
}): Promise<{ purchaseOrderId: string } | undefined> {
  const intent = await findRetailProcurementIntent(input);
  if (!intent) {
    throw new Error(
      `No retail procurement intent exists for order ${input.orderId} and supplier ` +
        `${input.supplierId}; a purchase order cannot be composed from nothing.`,
    );
  }
  if (intent.purchaseOrderId !== null) {
    // Already created. The outbox row is being redelivered, or an operator
    // drove the same intent by hand — both converge here rather than at #124's
    // own idempotency key, which saves a provider round trip.
    return { purchaseOrderId: intent.purchaseOrderId };
  }

  const lines = await listRetailProcurementIntentLines(intent.id);
  if (lines.length === 0) {
    await markRetailIntentFailed({
      id: intent.id,
      kind: 'supply_side_ineligible',
      detail: 'the intent carries no lines',
    });
    return undefined;
  }

  const result = await createPurchaseOrderForOrder({
    orderId: intent.orderId,
    supplierId: intent.supplierId,
    supplierAccountId: intent.supplierAccountId,
    agreementId: intent.agreementId,
    currency: intent.supplierCostCurrency,
    // The supplier-side figures, verbatim. The purchase order records what
    // Mercaria agreed to PAY; the buyer's locked total is a different number on
    // a different row and never travels to a supplier.
    itemsAmount: intent.supplierCostAmount,
    totalAmount: intent.supplierCostAmount,
    ...(lines[0]?.supplierQuoteRef ? { quoteRef: lines[0].supplierQuoteRef } : {}),
    lines: lines.map((line) => ({
      procurementOfferId: line.procurementOfferId,
      supplierSku: line.supplierSku,
      ...(line.canonicalProductId ? { canonicalProductId: line.canonicalProductId } : {}),
      ...(line.canonicalVariantId ? { canonicalVariantId: line.canonicalVariantId } : {}),
      quantity: line.quantity,
      unitCostAmount: line.supplierUnitCostAmount,
      unitCostCurrency: line.supplierUnitCostCurrency,
      lineTotalAmount: line.supplierLineTotalAmount,
      lineTotalCurrency: line.supplierLineTotalCurrency,
    })),
  });

  await attachRetailIntentPurchaseOrder({
    id: intent.id,
    purchaseOrderId: result.purchaseOrder.id,
  });

  // Hand it to #124. The submission row's id is derived from the purchase
  // order, so this enqueue is a no-op if the order was already queued — which
  // is what makes the whole path safe to run twice.
  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderSubmissionEventId(result.purchaseOrder.id),
    eventType: 'purchase_order_submission',
    payload: { purchaseOrderId: result.purchaseOrder.id },
  });

  log.general.info(
    {
      orderId: intent.orderId,
      supplierId: intent.supplierId,
      purchaseOrderId: result.purchaseOrder.id,
      created: result.created,
    },
    '[Retail] purchase order created from a frozen procurement intent',
  );
  return { purchaseOrderId: result.purchaseOrder.id };
}

/**
 * A supplier definitively refused, expired or was cancelled: enqueue the
 * compensating refund.
 *
 * Called from #124's outcome port, which is why this takes ids and a kind
 * rather than a purchase-order row: the procurement domain must not import the
 * payment domain (ADR 0004 D1), so the crossing is a narrow function whose
 * signature carries no payment type in either direction.
 *
 * DEFINITIVE is the whole precondition. A retryable provider error, an
 * ambiguous submission and an unanswered poll are none of them — those are
 * #124's own machinery, and refunding a buyer for a timeout that resolves an
 * hour later refunds them for goods that are on their way.
 */
export async function requestRetailCompensatingRefund(input: {
  orderId: string;
  purchaseOrderId: string;
  kind: RetailProcurementFailureKind;
  detail: string;
}): Promise<boolean> {
  const created = await enqueuePaymentEvent(getDb(), {
    id: retailProcurementFailedEventId(input.purchaseOrderId),
    eventType: 'retail_procurement_failed',
    payload: {
      orderId: input.orderId,
      purchaseOrderId: input.purchaseOrderId,
      failureKind: input.kind,
      failureDetail: input.detail,
    },
  });
  log.general.info(
    { ...input, created },
    created
      ? '[Retail] compensating refund requested for a failed procurement'
      : '[Retail] a compensating refund was already requested for this purchase order',
  );
  return created;
}

/**
 * What one intent's compensating refund is worth, and the record #128 needs.
 *
 * The BUYER-side locked total for this supplier's lines, which is the figure
 * the buyer actually paid for goods they will not receive. Not the supplier
 * cost: Mercaria absorbs the Stripe fee and any cost difference (ADR 0004 D8.7
 * case b), and refunding the wholesale figure would return less than the buyer
 * paid.
 *
 * The variance record written beside it is not bookkeeping tidiness. A failed
 * procurement means the attributable supplier cost for these lines is ZERO, so
 * the whole locked amount is owed back — which is the largest `customer_owed`
 * variance there is, and #128 reconciles the refund against it. Recording it
 * here rather than leaving it to the refund's own trail is what makes the
 * refund and the reconciliation input describe ONE event.
 */
export async function resolveCompensatingRefundAmount(input: {
  orderId: string;
  purchaseOrderId: string;
}): Promise<{ intent: RetailProcurementIntentRecord; amountMinor: number; currency: string }> {
  const order = await findOrderById(input.orderId);
  if (!order) {
    throw new Error(`Order ${input.orderId} does not exist; nothing to refund.`);
  }
  if (order.commercialRole !== 'mercaria_retail') {
    // A compensating refund names a retail order by construction, so reaching
    // here means #124 reported a purchase order against a marketplace order.
    // Refusing loudly beats refunding a connected merchant's buyer for a
    // supplier failure that has nothing to do with their sale.
    throw conflict('A compensating refund may only be created for a Mercaria-retail order.');
  }

  const intents = await listRetailProcurementIntents(input.orderId);
  const intent = intents.find((row) => row.purchaseOrderId === input.purchaseOrderId);
  if (!intent) {
    throw new Error(
      `Purchase order ${input.purchaseOrderId} names no procurement intent on order ` +
        `${input.orderId}.`,
    );
  }

  // The reconciliation input #128 books. `ON CONFLICT DO NOTHING`, so a
  // redelivered failure records once — the same convergence the outbox row's id
  // already gives, restated where the row is written because the two are
  // separate transactions.
  await recordRetailCostVariance({
    orderId: input.orderId,
    intentId: intent.id,
    purchaseOrderId: input.purchaseOrderId,
    source: 'purchase_order_cancelled',
    lockedAmount: intent.buyerLockedTotalAmount,
    // ZERO: procurement did not happen, so no supplier cost is attributable to
    // these lines. Everything the buyer paid for them is owed back.
    actualAmount: 0,
    currency: intent.buyerLockedTotalCurrency,
  });

  return {
    intent,
    amountMinor: intent.buyerLockedTotalAmount,
    currency: intent.buyerLockedTotalCurrency,
  };
}

/**
 * A supplier ACCEPTED at a cost: record the variance against the lock.
 *
 * The earliest actual cost #123 can observe, and observing it here rather than
 * waiting for an invoice is the difference between a surplus being visible for
 * the window in which a buyer might ask about it and being invisible for weeks.
 *
 * It BOOKS NOTHING. Recognizing the variance — moving it to
 * `customer_adjustment`, deciding whether it clears the automatic-refund
 * threshold, disposing of it at finality — is D8's set of decisions and #128's
 * to make. This writes the input those decisions read, and the absence of an
 * account column on the row is what stops it doing more.
 */
export async function recordSupplierAcceptanceVariance(input: {
  orderId: string;
  purchaseOrderId: string;
  acceptedCostMinor: number;
}): Promise<boolean> {
  const intents = await listRetailProcurementIntents(input.orderId);
  const intent = intents.find((row) => row.purchaseOrderId === input.purchaseOrderId);
  if (!intent) return false;

  // The comparison is BUYER-side against BUYER-side, and the accepted supplier
  // cost is translated into it by the difference from what was quoted — never
  // compared directly. A supplier billing in USD against a buyer charged in EUR
  // would otherwise produce a "variance" that is entirely an exchange rate.
  const costDeltaMinor = input.acceptedCostMinor - intent.supplierCostAmount;
  const actualMinor = intent.buyerLockedTotalAmount + costDeltaMinor;
  const record = await recordRetailCostVariance({
    orderId: input.orderId,
    intentId: intent.id,
    purchaseOrderId: input.purchaseOrderId,
    source: 'supplier_acceptance',
    lockedAmount: intent.buyerLockedTotalAmount,
    // Clamped at zero because an actual cost is not a negative number; a
    // supplier accepting at a credit is a #128 reconciliation case, not a
    // customer one.
    actualAmount: Math.max(0, actualMinor),
    currency: intent.buyerLockedTotalCurrency,
  });
  return record !== undefined;
}

/**
 * Commit the compensating refund for one failed purchase order, and enqueue its
 * execution (ADR 0004 D4 step 5, ADR 0001 D7).
 *
 * The commerce record commits BEFORE the rail is called, exactly as every other
 * refund does, and for the reason #49 states: a provider call living in the
 * request that created the refund evaporates on a restart and leaves a record
 * claiming money went back to a buyer who never received it. The refund row and
 * its `payment_refunded` outbox row commit in ONE transaction; the rail is
 * called from that row's handler under `re:<refundId>`, unchanged.
 *
 * ## Nothing is restocked, and that is not an omission
 *
 * ADR 0004 D5: a retail line reserved no local inventory, so there is nothing
 * to put back. `restockedAt` is deliberately absent rather than set to now —
 * stamping it would tell a merchant surface that units returned to a shelf that
 * never held them.
 *
 * ## Per-line, because a multi-supplier order fails per supplier
 *
 * ADR 0004 concern 11: failed lines cancel with a per-line compensating partial
 * refund and fulfilled lines proceed, landing the order in the existing
 * `partially_refunded` vocabulary. The lines refunded are exactly the failed
 * purchase order's own, which is why the amount comes off the INTENT rather
 * than off the order's grand total.
 */
export async function createRetailCompensatingRefund(input: {
  orderId: string;
  purchaseOrderId: string;
}): Promise<{ id: string } | undefined> {
  const { intent, amountMinor, currency } = await resolveCompensatingRefundAmount(input);
  if (amountMinor <= 0) return undefined;

  const order = await findOrderById(input.orderId);
  if (!order) throw new Error(`Order ${input.orderId} does not exist; nothing to refund.`);
  if (order.paymentStatus !== 'paid') {
    // Procurement is triggered from `paid` and the buyer's money is captured by
    // then, so an unpaid order here means the charge was reversed by another
    // path (a dispute, a sweep). Refunding again would return money twice.
    log.general.warn(
      { orderId: input.orderId, purchaseOrderId: input.purchaseOrderId },
      '[Retail] procurement failed on an order that is no longer paid; no refund created',
    );
    return undefined;
  }

  const lines = await listRetailProcurementIntentLines(intent.id);
  const itemByVariant = new Map(order.items.map((item) => [item.variantId, item]));
  const refundLines: NewRefundLineItem[] = [];
  for (const line of lines) {
    // The order item is matched by the CANONICAL VARIANT the intent line names,
    // through the order's own items. An intent line whose item is gone cannot
    // be refunded per line; the amount is still owed, which is why the total
    // below comes off the intent and not off the sum of these lines.
    const item = [...itemByVariant.values()].find(
      (candidate) => candidate.lineTotalPresentmentAmount === line.buyerAcceptedTotalAmount,
    );
    if (!item) continue;
    refundLines.push({
      variantId: item.variantId,
      quantity: line.quantity,
      amount: {
        shop: { amount: line.buyerAcceptedTotalAmount, currency: line.buyerAcceptedTotalCurrency },
        presentment: {
          amount: line.buyerAcceptedTotalAmount,
          currency: line.buyerAcceptedTotalCurrency,
        },
      },
      restock: false,
    });
  }

  const totalRefunded = {
    shop: { amount: amountMinor, currency: currency as CurrencyCode },
    presentment: { amount: amountMinor, currency: currency as CurrencyCode },
  };
  const providerOperation =
    order.paymentId !== null && order.paymentProvider !== null
      ? { provider: order.paymentProvider, paymentId: order.paymentId }
      : undefined;

  try {
    return await getDb().transaction(async (tx) => {
      const refund = await insertRefund(
        {
          orderId: input.orderId,
          type: 'refund',
          status: 'refunded',
          reason: 'We could not source this item, so we have refunded it in full.',
          lineItems: refundLines,
          totalRefunded,
          // Derived from the PURCHASE ORDER, so a re-delivered failure and an
          // operator's retry converge on the refund that exists rather than
          // returning the buyer's money a second time.
          idempotencyKey: `retail-procurement-failed:${input.purchaseOrderId}`,
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
            orderId: input.orderId,
            paymentId: providerOperation.paymentId,
          },
        });
      }
      return { id: refund.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'refunds_idempotency_key_key')) {
      // The convergence this key exists for. Returning `undefined` rather than
      // the prior refund is deliberate: the caller's only use for the value is
      // a log line, and reading a refund back to log it would be a query for
      // nothing.
      return undefined;
    }
    throw err;
  }
}
