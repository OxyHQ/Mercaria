/**
 * The authoritative records a reconciliation reads, and NOTHING else (#128
 * "Reconciliation sources").
 *
 * Every read in this file is against a FROZEN record: the order's own totals,
 * #123's procurement intent, #120's immutable quote, the payment, the refunds,
 * the disputes, #124's purchase orders and the documents a supplier issued.
 *
 * ## What is not here is the point
 *
 * There is no read of `procurement_offers`, no read of a listing or a variant
 * price, and no call to `fx.service`. "Never infer final cost from the current
 * catalog price after the order" and "never revalue historical order truth using
 * today's rate" are held by this file having no way to ask either question —
 * and by `retail-reconciliation-isolation.test.ts`, which fails the build if a
 * module in the domain learns to.
 *
 * The reads live in this domain's own repository rather than being added to the
 * payment, order and procurement repositories, because a reconciliation asks
 * questions none of those domains asks of itself (`every refund on this order`,
 * `every document across this order's purchase orders`) and growing them there
 * would put a reconciliation-shaped read in front of every other caller.
 */

import { asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orders, refunds } from '../schema/orders.js';
import { disputes } from '../schema/payments.js';
import { purchaseOrders } from '../schema/procurement.js';
import { purchaseOrderDocuments } from '../schema/supplierOrders.js';

/** The order facts a reconciliation needs, and no buyer identity at all. */
export interface ReconcilableOrder {
  id: string;
  checkoutGroupId: string;
  commercialRole: string;
  status: string;
  paymentStatus: string;
  paymentId: string | null;
  paidAt: Date | null;
  deliveredAt: Date | null;
}

/**
 * One retail order's reconcilable facts.
 *
 * `delivered_at` is derived from the status history rather than read off a
 * column, because `orders` has none: ADR 0004 D8.6 measures the finality
 * ceiling from DELIVERY, and the transition is the only record of when that
 * happened.
 */
export async function findReconcilableOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReconcilableOrder | undefined> {
  const rows = await db.execute<{
    id: string;
    checkout_group_id: string;
    commercial_role: string;
    status: string;
    payment_status: string;
    payment_id: string | null;
    paid_at: Date | null;
    delivered_at: Date | null;
  }>(sql`
    select o.id,
           o.checkout_group_id,
           o.commercial_role,
           o.status,
           o.payment_status,
           o.payment_id,
           o.paid_at,
           (
             select min(h.at) from order_status_history h
             where h.order_id = o.id and h.to_status = 'delivered'
           ) as delivered_at
    from orders o
    where o.id = ${orderId}
    limit 1
  `);
  const row = [...rows][0];
  if (!row) return undefined;
  return {
    id: row.id,
    checkoutGroupId: row.checkout_group_id,
    commercialRole: row.commercial_role,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentId: row.payment_id,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
  };
}

/** One refund of one order, in the presentment currency the buyer paid in. */
export interface OrderRefundRecord {
  id: string;
  amountMinor: number;
  currency: string;
  providerState: string | null;
  /** `null` for a refund committed by any path that does not derive one. */
  idempotencyKey: string | null;
  createdAt: Date;
}

/**
 * Every refund on one order.
 *
 * Deliberately NOT store-scoped: `findRefundsForOrderInStore` is the merchant
 * surface's read and a retail order has no store (`seller_type = 'platform'`),
 * so it would return nothing for every order this domain exists to reconcile.
 *
 * A refund that the rail FAILED is still counted, because the commerce record
 * committed and the buyer is owed it (ADR 0001 D7). Excluding it would make the
 * customer side look larger than it is and manufacture a surplus to refund a
 * second time.
 */
export async function listRefundsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRefundRecord[]> {
  const rows = await db
    .select({
      id: refunds.id,
      amountMinor: refunds.totalRefundedPresentmentAmount,
      currency: refunds.totalRefundedPresentmentCurrency,
      providerState: refunds.providerState,
      // The refund's own idempotency key, which is how a refund committed BY a
      // #127 service request is told apart from any other refund on the order.
      idempotencyKey: refunds.idempotencyKey,
      createdAt: refunds.createdAt,
    })
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(asc(refunds.createdAt));
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerState: row.providerState,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  }));
}

/** One dispute movement against one order. */
export interface OrderDisputeRecord {
  id: string;
  providerDisputeId: string;
  amountMinor: number;
  currency: string;
  status: string;
  outcome: string | null;
  createdAt: Date;
}

/**
 * Every dispute naming one order.
 *
 * A WARNING books nothing and moves nothing — #49 tells an inquiry apart by the
 * rail's empty balance movements — so the caller filters on the outcome rather
 * than this read doing it: an operator trace wants to see an open dispute that
 * the equation must not count.
 */
export async function listDisputesForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderDisputeRecord[]> {
  const rows = await db
    .select({
      id: disputes.id,
      providerDisputeId: disputes.providerDisputeId,
      amountMinor: disputes.amountAmount,
      currency: disputes.amountCurrency,
      status: disputes.status,
      outcome: disputes.outcome,
      createdAt: disputes.createdAt,
    })
    .from(disputes)
    .where(eq(disputes.orderId, orderId))
    .orderBy(asc(disputes.createdAt));
  return rows;
}

/**
 * One purchase order of one retail order, with the breakdown it was placed at.
 *
 * #124 records the supplier's own split — items, shipping, tax, duty — in ONE
 * currency, which is what lets #128 represent the cost components separately
 * (its accounting model's items 2, 3 and 4) instead of attributing one blended
 * figure to the item cost. `taxAmount` here is the B2B tax on the supply TO
 * Mercaria, which is input-deductible under reverse charge (ADR 0004 D2.4) and
 * is NOT the customer's tax — the caller keeps them apart.
 */
export interface OrderPurchaseOrderRecord {
  id: string;
  supplierId: string;
  status: string;
  currency: string;
  itemsAmount: number;
  shippingAmount: number;
  taxAmount: number;
  dutyAmount: number;
  totalAmount: number;
  acceptedAt: Date | null;
  createdAt: Date;
}

/**
 * Every purchase order placed for one retail order.
 *
 * ADR 0004 D5: one per supplier. The read is by ORDER and not by intent,
 * because an intent whose purchase order was never created has none and an
 * operator reconciling that order still needs to see the absence.
 */
export async function listPurchaseOrdersForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPurchaseOrderRecord[]> {
  const rows = await db
    .select({
      id: purchaseOrders.id,
      supplierId: purchaseOrders.supplierId,
      status: purchaseOrders.status,
      currency: purchaseOrders.currency,
      itemsAmount: purchaseOrders.itemsAmount,
      shippingAmount: purchaseOrders.shippingAmount,
      taxAmount: purchaseOrders.taxAmount,
      dutyAmount: purchaseOrders.dutyAmount,
      totalAmount: purchaseOrders.totalAmount,
      acceptedAt: purchaseOrders.acceptedAt,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.orderId, orderId))
    .orderBy(asc(purchaseOrders.createdAt));
  return rows;
}

/** One document a supplier issued against a purchase order. */
export interface SupplierDocumentRecord {
  id: string;
  purchaseOrderId: string;
  kind: string;
  providerDocumentId: string;
  documentNumber: string | null;
  currency: string;
  totalAmount: number;
  taxAmount: number | null;
  relatedProviderDocumentId: string | null;
  issuedAt: Date;
  retrievedAt: Date;
}

/** Every invoice and credit note across a set of purchase orders. */
export async function listSupplierDocumentsForPurchaseOrders(
  purchaseOrderIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierDocumentRecord[]> {
  if (purchaseOrderIds.length === 0) return [];
  const rows = await db
    .select({
      id: purchaseOrderDocuments.id,
      purchaseOrderId: purchaseOrderDocuments.purchaseOrderId,
      kind: purchaseOrderDocuments.kind,
      providerDocumentId: purchaseOrderDocuments.providerDocumentId,
      documentNumber: purchaseOrderDocuments.documentNumber,
      currency: purchaseOrderDocuments.currency,
      totalAmount: purchaseOrderDocuments.totalAmount,
      taxAmount: purchaseOrderDocuments.taxAmount,
      relatedProviderDocumentId: purchaseOrderDocuments.relatedProviderDocumentId,
      issuedAt: purchaseOrderDocuments.issuedAt,
      retrievedAt: purchaseOrderDocuments.retrievedAt,
    })
    .from(purchaseOrderDocuments)
    .where(inArray(purchaseOrderDocuments.purchaseOrderId, [...purchaseOrderIds]))
    .orderBy(asc(purchaseOrderDocuments.issuedAt));
  return rows;
}

/**
 * Every ORDER in one checkout group with the retail share it locked.
 *
 * The apportionment basis for a group-level cost — the provider's processing
 * fee is charged once for the whole PaymentIntent (ADR 0001 D4), so attributing
 * it needs every sibling's weight and not just this order's. A mixed group's
 * marketplace siblings are included, which is what stops a retail order in a
 * three-order cart being charged the whole fee.
 */
export async function listCheckoutGroupOrderWeights(
  checkoutGroupId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ orderId: string; weightMinor: number }[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      weightMinor: orders.totalsGrandTotalPresentmentAmount,
    })
    .from(orders)
    .where(eq(orders.checkoutGroupId, checkoutGroupId))
    .orderBy(asc(orders.id));
  return rows;
}

/**
 * The two most recent supplier funding observations for one account.
 *
 * The prefund-top-up derivation's input. #125 records a BALANCE per observation
 * and never a movement — a top-up is a treasury act performed outside this
 * application (ADR 0004 D6.5) — so the movement has to be derived from two
 * consecutive balances plus the draws booked between them.
 */
export async function listRecentSupplierFundingObservations(
  input: { supplierAccountId: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<
  { id: string; supplierId: string; balanceMinor: number; currency: string; observedAt: Date }[]
> {
  const rows = await db.execute<{
    id: string;
    supplier_id: string;
    balance_minor: string;
    currency: string;
    observed_at: Date;
  }>(sql`
    select f.id,
           a.supplier_id,
           f.balance_amount as balance_minor,
           f.balance_currency as currency,
           f.observed_at
    from supplier_funding_observations f
    join supplier_accounts a on a.id = f.supplier_account_id
    where f.supplier_account_id = ${input.supplierAccountId}
    order by f.observed_at desc
    limit ${input.limit}
  `);
  // `balance_amount` is a bigint column read through a RAW statement, so
  // drizzle's `mode: 'number'` result mapper does not apply and postgres.js
  // hands it back as a STRING.
  return [...rows].map((row) => ({
    id: row.id,
    supplierId: row.supplier_id,
    balanceMinor: Number(row.balance_minor),
    currency: row.currency,
    observedAt: row.observed_at,
  }));
}

/** Every supplier account that has at least one funding observation. */
export async function listFundedSupplierAccounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ supplierAccountId: string; supplierId: string }[]> {
  const rows = await db.execute<{ supplier_account_id: string; supplier_id: string }>(sql`
    select distinct f.supplier_account_id, a.supplier_id
    from supplier_funding_observations f
    join supplier_accounts a on a.id = f.supplier_account_id
  `);
  return [...rows].map((row) => ({
    supplierAccountId: row.supplier_account_id,
    supplierId: row.supplier_id,
  }));
}
