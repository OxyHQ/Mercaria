import { and, eq } from 'drizzle-orm';
import type { PurchaseApproval, PurchaseEffects } from '@oxy.so/contracts';
import { purchaseEffectsSchema } from '@oxy.so/contracts';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { payments } from '../../db/schema/payments.js';
import {
  supervisedCheckoutRequests,
  supervisedPurchaseLines,
  supervisedPurchaseOperations,
} from '../../db/schema/supervisedShopping.js';
import {
  findPaymentById,
  findNativePaymentByCheckoutGroupId,
  type PaymentRow,
} from '../../db/payments/paymentRepository.js';
import {
  findCheckoutGroupsByRequestKey,
  findOrdersByCheckoutGroup,
  type OrderRecord,
} from '../../db/orders/orderRepository.js';
import { findCartByOwner } from '../../db/buyers/cartRepository.js';
import { findStoresByIds } from '../../db/stores/storeRepository.js';
import { conflict, forbidden, notFound } from '../../lib/errors/error-codes.js';
import { oxyClient } from '../../middleware/auth.js';
import { readableShoppingListings } from './catalog.service.js';
import { shoppingContentDigest } from './catalog-review.service.js';
import { buildPurchaseEvidence } from './purchase-evidence.js';
import { enqueuePaymentEvent } from '../payments/payment-outbox.service.js';

/** Constructed only after the shared Oxy middleware verifies the original bearer. */
export interface SupervisedPurchaseContext {
  buyerOxyUserId: string;
  accessToken: string;
  phase: 'prepare' | 'resume';
  requestFingerprint?: string;
  selectionFingerprint?: string;
}
export function shoppingSelectionFingerprint(
  items: readonly { variantId: string; quantity: number }[],
): string {
  return shoppingContentDigest(
    [...items]
      .sort((a, b) => a.variantId.localeCompare(b.variantId))
      .map(({ variantId, quantity }) => ({ variantId, quantity })),
  );
}

/** The request survives Redis loss and crashes before the approval operation exists. */
export async function recoverSupervisedCheckout(
  context: SupervisedPurchaseContext,
  key: string,
): Promise<string | undefined> {
  if (!context.requestFingerprint) throw conflict('The checkout request identity is missing.');
  const db = getDb();
  const cart = await findCartByOwner({ kind: 'oxy_user', oxyUserId: context.buyerOxyUserId });
  const items = cart?.items ?? [];
  const selectionFingerprint = shoppingSelectionFingerprint(items);
  const predicate = and(
    eq(supervisedCheckoutRequests.buyerOxyUserId, context.buyerOxyUserId),
    eq(supervisedCheckoutRequests.idempotencyKey, key),
  );
  let [request] = await db.select().from(supervisedCheckoutRequests).where(predicate).limit(1);
  if (!request) {
    if (!items.length) throw conflict('Cart is empty');
    [request] = await db
      .insert(supervisedCheckoutRequests)
      .values({
        buyerOxyUserId: context.buyerOxyUserId,
        idempotencyKey: key,
        requestFingerprint: context.requestFingerprint,
        selectionFingerprint,
      })
      .onConflictDoNothing()
      .returning();
    if (!request)
      [request] = await db.select().from(supervisedCheckoutRequests).where(predicate).limit(1);
  }
  if (
    !request ||
    request.requestFingerprint !== context.requestFingerprint ||
    (items.length > 0 && request.selectionFingerprint !== selectionFingerprint)
  ) {
    throw conflict('This checkout key already belongs to a different request.');
  }
  context.selectionFingerprint = request.selectionFingerprint;
  const groups = await findCheckoutGroupsByRequestKey(context.buyerOxyUserId, key);
  if (groups.length > 1) throw conflict('The checkout request has inconsistent order groups.');
  if (groups[0]) {
    const orders = await findOrdersByCheckoutGroup(groups[0], {
      kind: 'oxy_user',
      oxyUserId: context.buyerOxyUserId,
    });
    if (
      shoppingSelectionFingerprint(orders.flatMap((order) => order.items)) !==
      request.selectionFingerprint
    ) {
      throw conflict('The persisted checkout does not contain the complete approved selection.');
    }
  }
  return groups[0];
}

type Operation = typeof supervisedPurchaseOperations.$inferSelect;
type ReviewedLine = typeof supervisedPurchaseLines.$inferSelect;

/** Frozen seller allocations and delivery effects also participate, even when the guardian
 * preview displays the combined totals. Mutable order/payment lifecycle fields never do. */
function checkoutFingerprint(
  evidence: ReturnType<typeof buildPurchaseEvidence>,
  orders: readonly OrderRecord[],
  reviews: readonly { orderItemId: string; contentDigest: string }[],
): string {
  return shoppingContentDigest({
    version: 1,
    evidence,
    orders: [...orders]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((order) => ({
        id: order.id,
        buyer: order.buyerOxyUserId,
        storeId: order.storeId,
        seller: order.sellerOxyUserId,
        shippingMethod: order.shippingMethod,
        destination: {
          recipientName: order.shippingAddressRecipientName,
          line1: order.shippingAddressLine1,
          line2: order.shippingAddressLine2,
          city: order.shippingAddressCity,
          region: order.shippingAddressRegion,
          postalCode: order.shippingAddressPostalCode,
          country: order.shippingAddressCountry,
          phone: order.shippingAddressPhone,
        },
        subtotal: [order.totalsSubtotalShopAmount, order.totalsSubtotalPresentmentAmount],
        shipping: [order.totalsShippingShopAmount, order.totalsShippingPresentmentAmount],
        tax: [order.totalsTaxShopAmount, order.totalsTaxPresentmentAmount],
        discount: [order.totalsDiscountTotalShopAmount, order.totalsDiscountTotalPresentmentAmount],
        total: [order.totalsGrandTotalShopAmount, order.totalsGrandTotalPresentmentAmount],
        fx: [
          order.fxRateFrom,
          order.fxRateTo,
          order.fxRateRate,
          order.fxRateProvider,
          order.fxRateAsOf,
        ],
        items: [...order.items]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((item) => ({
            id: item.id,
            listingId: item.listingId,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPriceShop: item.unitPriceShopAmount,
            lineTotalShop: item.lineTotalShopAmount,
            discountShop: item.discountTotalShopAmount,
            discountPresentment: item.discountTotalPresentmentAmount,
            locationId: item.locationId,
          })),
      })),
    reviews: [...reviews]
      .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId))
      .map(({ orderItemId, contentDigest }) => ({ orderItemId, contentDigest })),
  });
}

async function findOperation(paymentId: string): Promise<Operation | undefined> {
  const [row] = await getDb()
    .select()
    .from(supervisedPurchaseOperations)
    .where(eq(supervisedPurchaseOperations.paymentId, paymentId))
    .limit(1);
  return row;
}

async function merchantAccounts(orders: readonly OrderRecord[]): Promise<Map<string, string>> {
  const stores = await findStoresByIds([
    ...new Set(orders.flatMap((order) => (order.storeId ? [order.storeId] : []))),
  ]);
  const byStore = new Map(stores.map((store) => [store.id, store.oxyAccountId]));
  const result = new Map<string, string>();
  for (const order of orders) {
    if (order.commercialRole !== 'connected_marketplace' || order.shippingMethod === 'digital') {
      throw conflict('This purchase type is not available in supervised shopping.');
    }
    const accountId =
      order.sellerType === 'store'
        ? order.storeId
          ? byStore.get(order.storeId)
          : undefined
        : order.sellerOxyUserId;
    if (!accountId) throw conflict('The checkout merchant cannot be verified.');
    result.set(order.id, accountId);
  }
  return result;
}

async function currentReviewedLines(orders: readonly OrderRecord[], accessToken: string) {
  const items = orders.flatMap((order) => order.items);
  const readable = await readableShoppingListings(
    items.map((item) => item.listingId),
    accessToken,
  );
  return items.map((item) => {
    const listing = readable.get(item.listingId);
    const variant = listing?.variants.find((row) => row.id === item.variantId);
    if (
      !listing ||
      !variant ||
      item.title !== listing.title ||
      item.variantTitle !== variant.title ||
      JSON.stringify(item.optionValues.map(({ name, value }) => ({ name, value }))) !==
        JSON.stringify(variant.options)
    ) {
      throw conflict('An item changed or is no longer available for supervised shopping.');
    }
    return { orderItemId: item.id, contentDigest: listing.reviewDigest };
  });
}

function effectsFor(
  operation: Operation,
  payment: PaymentRow,
  orders: readonly OrderRecord[],
  lines: readonly ReviewedLine[],
): PurchaseEffects {
  const lineMerchants = new Map(lines.map((line) => [line.orderItemId, line.merchantAccountId]));
  const merchants = new Map(
    orders.map((order) => {
      const accountIds = new Set(order.items.map((item) => lineMerchants.get(item.id)));
      if (accountIds.size !== 1 || accountIds.has(undefined))
        throw conflict('The approved seller allocation is incomplete.');
      const [accountId] = accountIds;
      if (!accountId) throw conflict('The approved seller identity is missing.');
      return [order.id, accountId];
    }),
  );
  const evidence = buildPurchaseEvidence(orders, merchants);
  if (
    evidence.amountMinor !== payment.presentmentAmount ||
    evidence.currency !== payment.presentmentCurrency
  ) {
    throw conflict('The payment differs from its immutable checkout.');
  }
  const cartFingerprint = checkoutFingerprint(evidence, orders, lines);
  const paymentFingerprint = shoppingContentDigest({
    paymentId: payment.id,
    provider: payment.provider,
    checkoutGroupId: payment.checkoutGroupId,
    amount: payment.presentmentAmount,
    currency: payment.presentmentCurrency,
  });
  if (
    cartFingerprint !== operation.cartFingerprint ||
    paymentFingerprint !== operation.paymentFingerprint
  ) {
    throw conflict('The approval no longer matches this payment.');
  }
  return purchaseEffectsSchema.parse({
    ...evidence,
    operationId: operation.id,
    resourceId: `mercaria:checkout:${payment.checkoutGroupId}`,
    cartFingerprint,
    paymentFingerprint,
    expiresAt: operation.expiresAt.toISOString(),
  });
}

async function ensureOperation(
  payment: PaymentRow,
  orders: readonly OrderRecord[],
  context: SupervisedPurchaseContext,
): Promise<Operation> {
  const existing = await findOperation(payment.id);
  if (existing) return existing;
  const requestFingerprint = context.requestFingerprint;
  if (!requestFingerprint) throw conflict('The original checkout request is missing.');
  if (payment.providerObjectId || payment.status !== 'created')
    throw conflict('This payment already started outside supervised shopping.');
  const [merchants, reviews] = await Promise.all([
    merchantAccounts(orders),
    currentReviewedLines(orders, context.accessToken),
  ]);
  const evidence = buildPurchaseEvidence(orders, merchants);
  const reviewByItem = new Map(reviews.map((review) => [review.orderItemId, review.contentDigest]));
  const lines = orders.flatMap((order) =>
    order.items.map((item) => {
      const merchantAccountId = merchants.get(order.id);
      const contentDigest = reviewByItem.get(item.id);
      if (!merchantAccountId || !contentDigest)
        throw conflict('Reviewed purchase evidence is incomplete.');
      return { orderItemId: item.id, merchantAccountId, contentDigest };
    }),
  );
  const expiresAt = new Date(
    Math.min(...orders.map((order) => order.createdAt.getTime())) + config.orders.reservationTtlMs,
  );
  const cartFingerprint = checkoutFingerprint(evidence, orders, reviews);
  const paymentFingerprint = shoppingContentDigest({
    paymentId: payment.id,
    provider: payment.provider,
    checkoutGroupId: payment.checkoutGroupId,
    amount: payment.presentmentAmount,
    currency: payment.presentmentCurrency,
  });
  return getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(supervisedPurchaseOperations)
      .values({
        paymentId: payment.id,
        expiresAt,
        cartFingerprint,
        paymentFingerprint,
        requestFingerprint,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [prior] = await tx
        .select()
        .from(supervisedPurchaseOperations)
        .where(eq(supervisedPurchaseOperations.paymentId, payment.id));
      if (!prior) throw conflict('The checkout preparation could not be recovered.');
      return prior;
    }
    await tx
      .insert(supervisedPurchaseLines)
      .values(lines.map((line) => ({ ...line, operationId: created.id })));
    return created;
  });
}

/** Called inside the one native payment-open seam, before any PSP request/client secret. */
export async function permitSupervisedPayment(
  payment: PaymentRow,
  orders: readonly OrderRecord[],
  context?: SupervisedPurchaseContext,
): Promise<boolean> {
  const prior = await findOperation(payment.id);
  if (!prior && !context) return true;
  if (!context || context.buyerOxyUserId !== payment.buyerOxyUserId) {
    throw forbidden('Continue this purchase through supervised shopping.');
  }
  if (
    orders.some(
      (order) =>
        order.buyerOxyUserId !== context.buyerOxyUserId || order.status !== 'pending_payment',
    )
  ) {
    throw conflict('This checkout is no longer awaiting payment.');
  }
  const operation = prior ?? (await ensureOperation(payment, orders, context));
  if (context.phase === 'prepare') {
    if (context.requestFingerprint !== operation.requestFingerprint)
      throw conflict('This checkout key was already used for a different request.');
    return false;
  }
  if (!operation.approvalId) throw conflict('Guardian approval has not been requested.');
  const [lines, reviews, merchants] = await Promise.all([
    getDb()
      .select()
      .from(supervisedPurchaseLines)
      .where(eq(supervisedPurchaseLines.operationId, operation.id)),
    currentReviewedLines(orders, context.accessToken),
    merchantAccounts(orders),
  ]);
  const currentDigests = new Map(
    reviews.map((review) => [review.orderItemId, review.contentDigest]),
  );
  const orderByItem = new Map(
    orders.flatMap((order) => order.items.map((item) => [item.id, order.id] as const)),
  );
  if (
    lines.some(
      (line) =>
        currentDigests.get(line.orderItemId) !== line.contentDigest ||
        merchants.get(orderByItem.get(line.orderItemId) ?? '') !== line.merchantAccountId,
    )
  ) {
    throw conflict('Reviewed content or seller identity changed. Start a new checkout.');
  }
  const effects = effectsFor(operation, payment, orders, lines);
  await oxyClient.safety.reservePurchase({ ...effects, approvalId: operation.approvalId });
  // Short local transaction: cancellation and attempt start serialize on the
  // real payment row. No Oxy/PSP HTTP round trip runs while this lock is held.
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id))
      .for('update');
    if (!current || !['created', 'requires_action', 'processing'].includes(current.status)) {
      throw conflict('This payment cannot be opened again.');
    }
    const [liveOperation] = await tx
      .select()
      .from(supervisedPurchaseOperations)
      .where(eq(supervisedPurchaseOperations.id, operation.id))
      .for('update');
    if (!liveOperation || liveOperation.cancellationConfirmedAt)
      throw conflict('This purchase was cancelled.');
    if (!liveOperation.paymentStartedAt)
      await tx
        .update(supervisedPurchaseOperations)
        .set({ paymentStartedAt: new Date() })
        .where(eq(supervisedPurchaseOperations.id, operation.id));
  });
  return true;
}

/** Idempotent canonical read/request. The original child's bearer binds the subject in Oxy. */
export async function requestCheckoutApproval(
  checkoutGroupId: string,
  context: SupervisedPurchaseContext,
): Promise<PurchaseApproval> {
  const orders = await findOrdersByCheckoutGroup(checkoutGroupId, {
    kind: 'oxy_user',
    oxyUserId: context.buyerOxyUserId,
  });
  const payment = await findNativePaymentByCheckoutGroupId(getDb(), checkoutGroupId);
  if (!orders.length || !payment || payment.buyerOxyUserId !== context.buyerOxyUserId)
    throw notFound('Checkout not found.');
  const operation = await findOperation(payment.id);
  if (!operation) throw notFound('Supervised checkout not found.');
  const lines = await getDb()
    .select()
    .from(supervisedPurchaseLines)
    .where(eq(supervisedPurchaseLines.operationId, operation.id));
  const currentReviews = new Map(
    (await currentReviewedLines(orders, context.accessToken)).map((review) => [
      review.orderItemId,
      review.contentDigest,
    ]),
  );
  if (lines.some((line) => currentReviews.get(line.orderItemId) !== line.contentDigest)) {
    throw conflict(
      'Reviewed content changed. This purchase is unavailable for supervised shopping.',
    );
  }
  const approval = await oxyClient.safety.requestPurchaseApproval(
    effectsFor(operation, payment, orders, lines),
    { accessToken: context.accessToken },
  );
  if (approval.childAccountId !== context.buyerOxyUserId)
    throw forbidden('The approval belongs to another buyer.');
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(supervisedPurchaseOperations)
      .where(eq(supervisedPurchaseOperations.id, operation.id))
      .for('update');
    if (!current || (current.approvalId && current.approvalId !== approval.id))
      throw conflict('The approval identity changed.');
    if (!current.approvalId)
      await tx
        .update(supervisedPurchaseOperations)
        .set({ approvalId: approval.id })
        .where(eq(supervisedPurchaseOperations.id, operation.id));
    if (current.cancellationConfirmedAt)
      await enqueuePaymentEvent(tx, {
        id: `payment:supervised_purchase_cancelled:${payment.id}`,
        eventType: 'supervised_purchase_cancelled',
        payload: { paymentId: payment.id, checkoutGroupId: payment.checkoutGroupId },
      });
  });
  return approval;
}

/** Called only by the durable verified-payment-success outbox, never by a buyer callback. */
export async function confirmSupervisedPayment(paymentId: string): Promise<void> {
  const operation = await findOperation(paymentId);
  if (!operation) return;
  const payment = await findPaymentById(getDb(), paymentId);
  if (
    !operation.approvalId ||
    !operation.paymentStartedAt ||
    !payment?.providerObjectId ||
    !['succeeded', 'partially_refunded', 'refunded'].includes(payment.status)
  ) {
    throw conflict('The supervised payment has no confirmed provider receipt.');
  }
  await oxyClient.safety.confirmPurchase({
    approvalId: operation.approvalId,
    operationId: operation.id,
    receiptReference: `${payment.provider}:${payment.providerObjectId}`,
  });
}

/** A timeout/local cancellation alone proves nothing about an attempted charge. */
export async function recordSupervisedCancellation(
  paymentId: string,
  providerConfirmed: boolean,
): Promise<void> {
  if (!(await findOperation(paymentId))) return;
  await getDb().transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (payment?.status !== 'canceled') return;
    const [operation] = await tx
      .select()
      .from(supervisedPurchaseOperations)
      .where(eq(supervisedPurchaseOperations.paymentId, paymentId))
      .for('update');
    if (!operation || (operation.paymentStartedAt && !providerConfirmed)) return;
    if (!operation.cancellationConfirmedAt)
      await tx
        .update(supervisedPurchaseOperations)
        .set({ cancellationConfirmedAt: new Date() })
        .where(eq(supervisedPurchaseOperations.id, operation.id));
    if (operation.approvalId)
      await enqueuePaymentEvent(tx, {
        id: `payment:supervised_purchase_cancelled:${paymentId}`,
        eventType: 'supervised_purchase_cancelled',
        payload: { paymentId, checkoutGroupId: payment.checkoutGroupId },
      });
  });
}

/** Durable outbox retry closes Oxy only after the local/provider evidence commits. */
export async function cancelSupervisedApproval(paymentId: string): Promise<void> {
  const operation = await findOperation(paymentId);
  if (!operation) return;
  if (!operation.cancellationConfirmedAt)
    throw conflict('Payment cancellation has not been confirmed.');
  // A preparation that never requested Oxy approval has nothing external to close.
  if (!operation.approvalId) return;
  await oxyClient.safety.cancelPurchase({
    approvalId: operation.approvalId,
    operationId: operation.id,
  });
}
