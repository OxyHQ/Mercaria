/**
 * `draft_orders` and its four child tables — `draft_order_line_items`,
 * `draft_order_line_item_option_values`, `draft_order_applied_discounts`,
 * `draft_order_tax_lines`.
 *
 * A draft is the register's MUTABLE cart, and every mutation ends the same way:
 * re-price the whole thing and write the result back. That shape is what
 * {@link replaceDraftPricing} encodes — lines, allocations, tax lines and totals
 * are replaced WHOLESALE in one transaction, exactly as assigning a Mongoose
 * sub-document array did. Patching them individually would leave the previous
 * recompute's rows behind, and a draft carrying two generations of tax lines
 * charges both.
 *
 * Draft money is SINGLE currency throughout (`draft_orders.currency`): a POS sale
 * settles and charges in the store's own currency, and only acquires a
 * presentment side when it becomes an order.
 *
 * ## The line ids are not stable across a recompute, and nothing depends on them
 *
 * Wholesale replacement mints new `draft_order_line_items.id`s every time. No
 * client, order, refund or report ever references one — the register addresses a
 * line by its VARIANT, which is what `updateLine`/`removeLine` take — so the
 * churn is invisible. If anything ever needs a stable line id, that is the day
 * this becomes a diff rather than a replace, not a day to add an id nobody reads.
 */

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import type {
  AddressSnapshot,
  CurrencyCode,
  DraftOrderStatus,
  Money,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  draftOrderAppliedDiscounts,
  draftOrderLineItemOptionValues,
  draftOrderLineItems,
  draftOrderTaxLines,
  draftOrders,
} from '../schema/pos.js';

/** One row of `draft_orders`. */
export type DraftOrderRow = InferSelectModel<typeof draftOrders>;

/** One row of `draft_order_line_items`. */
export type DraftLineItemRow = InferSelectModel<typeof draftOrderLineItems>;

/** One row of `draft_order_line_item_option_values`. */
export type DraftLineOptionValueRow = InferSelectModel<typeof draftOrderLineItemOptionValues>;

/** One row of `draft_order_applied_discounts`. */
export type DraftAppliedDiscountRow = InferSelectModel<typeof draftOrderAppliedDiscounts>;

/** One row of `draft_order_tax_lines`. */
export type DraftTaxLineRow = InferSelectModel<typeof draftOrderTaxLines>;

/** A draft line with its printed `{name, value}` pairs attached. */
export interface DraftLineItemRecord extends DraftLineItemRow {
  readonly optionValues: DraftLineOptionValueRow[];
}

/** A draft with all four child relations attached — what callers read. */
export interface DraftOrderRecord extends DraftOrderRow {
  readonly lineItems: DraftLineItemRecord[];
  readonly appliedDiscounts: DraftAppliedDiscountRow[];
  readonly taxLines: DraftTaxLineRow[];
}

/** A draft line as a caller supplies it. */
export interface NewDraftLineItem {
  listingId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  unitPrice: Money;
  quantity: number;
  discountTotal?: Money;
  optionValues: { name: string; value: string }[];
}

/** One discount's contribution to the draft as a caller supplies it. */
export interface NewDraftAppliedDiscount {
  discountId: string;
  code?: string;
  title: string;
  valueType: DraftAppliedDiscountRow['valueType'];
  amount: Money;
  target: 'order' | 'line';
  targetLineIndex?: number;
}

/** One applied tax rate's contribution to the draft as a caller supplies it. */
export interface NewDraftTaxLine {
  name: string;
  rateBps: number;
  amount: Money;
}

/** The five single-currency totals a recompute produces. */
export interface DraftTotals {
  subtotal: Money;
  discountTotal: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
}

/** A draft as a caller opens it — no lines, zero totals. */
export interface NewDraftOrder {
  storeId: string;
  createdByOxyUserId: string;
  locationId?: string;
  customerId?: string;
  currency: CurrencyCode;
  totals: DraftTotals;
}

/** Everything a recompute rewrites, replaced wholesale. */
export interface DraftPricing {
  lineItems: NewDraftLineItem[];
  appliedDiscounts: NewDraftAppliedDiscount[];
  taxLines: NewDraftTaxLine[];
  totals: DraftTotals;
}

/** Attach every child relation to a batch of draft rows, batched per relation. */
async function withChildren(
  rows: DraftOrderRow[],
  db: DatabaseOrTransaction,
): Promise<DraftOrderRecord[]> {
  if (rows.length === 0) return [];
  const draftIds = rows.map((row) => row.id);

  const [lineRows, discountRows, taxRows] = await Promise.all([
    db
      .select()
      .from(draftOrderLineItems)
      .where(inArray(draftOrderLineItems.draftOrderId, draftIds))
      .orderBy(asc(draftOrderLineItems.position), asc(draftOrderLineItems.id)),
    db
      .select()
      .from(draftOrderAppliedDiscounts)
      .where(inArray(draftOrderAppliedDiscounts.draftOrderId, draftIds))
      .orderBy(asc(draftOrderAppliedDiscounts.position), asc(draftOrderAppliedDiscounts.id)),
    db
      .select()
      .from(draftOrderTaxLines)
      .where(inArray(draftOrderTaxLines.draftOrderId, draftIds))
      .orderBy(asc(draftOrderTaxLines.position), asc(draftOrderTaxLines.id)),
  ]);

  const optionRows =
    lineRows.length > 0
      ? await db
          .select()
          .from(draftOrderLineItemOptionValues)
          .where(
            inArray(
              draftOrderLineItemOptionValues.draftOrderLineItemId,
              lineRows.map((line) => line.id),
            ),
          )
          .orderBy(
            asc(draftOrderLineItemOptionValues.position),
            asc(draftOrderLineItemOptionValues.id),
          )
      : [];

  const optionsByLine = groupBy(optionRows, (row) => row.draftOrderLineItemId);
  const lines = lineRows.map((line) => ({
    ...line,
    optionValues: optionsByLine.get(line.id) ?? [],
  }));

  const linesByDraft = groupBy(lines, (row) => row.draftOrderId);
  const discountsByDraft = groupBy(discountRows, (row) => row.draftOrderId);
  const taxByDraft = groupBy(taxRows, (row) => row.draftOrderId);

  return rows.map((row) => ({
    ...row,
    lineItems: linesByDraft.get(row.id) ?? [],
    appliedDiscounts: discountsByDraft.get(row.id) ?? [],
    taxLines: taxByDraft.get(row.id) ?? [],
  }));
}

/** Bucket rows by a key, preserving the order the query returned them in. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

/** The five totals as flat columns. Shared by the create and recompute paths. */
function totalsColumns(totals: DraftTotals) {
  return {
    totalsSubtotalAmount: totals.subtotal.amount,
    totalsSubtotalCurrency: totals.subtotal.currency,
    totalsDiscountTotalAmount: totals.discountTotal.amount,
    totalsDiscountTotalCurrency: totals.discountTotal.currency,
    totalsTaxAmount: totals.tax.amount,
    totalsTaxCurrency: totals.tax.currency,
    totalsShippingAmount: totals.shipping.amount,
    totalsShippingCurrency: totals.shipping.currency,
    totalsGrandTotalAmount: totals.grandTotal.amount,
    totalsGrandTotalCurrency: totals.grandTotal.currency,
  };
}

/** One draft scoped to its store, or `null` — the scoping IS the authorization. */
export async function findDraftOrder(
  storeId: string,
  draftId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DraftOrderRecord | null> {
  const rows = await db
    .select()
    .from(draftOrders)
    .where(and(eq(draftOrders.id, draftId), eq(draftOrders.storeId, storeId)))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/** A page of a store's drafts, newest first, plus the total matching count. */
export async function findDraftOrdersPage(
  storeId: string,
  filter: { status?: DraftOrderStatus },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: DraftOrderRecord[]; total: number }> {
  const where: SQL | undefined = filter.status
    ? and(eq(draftOrders.storeId, storeId), eq(draftOrders.status, filter.status))
    : eq(draftOrders.storeId, storeId);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(draftOrders)
      .where(where)
      // `desc nulls last` matches `draft_orders_store_id_status_created_at_idx`;
      // a bare `DESC` is NULLS FIRST in Postgres and cannot use it for ordering.
      .orderBy(
        sql`${draftOrders.createdAt} desc nulls last`,
        sql`${draftOrders.id} desc nulls last`,
      )
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(draftOrders).where(where),
  ]);

  return { rows: await withChildren(rows, db), total: totalRow?.total ?? 0 };
}

/** Open a new draft with no lines. */
export async function insertDraftOrder(
  input: NewDraftOrder,
  db: DatabaseOrTransaction = getDb(),
): Promise<DraftOrderRecord> {
  const [row] = await db
    .insert(draftOrders)
    .values({
      storeId: input.storeId,
      locationId: input.locationId ?? null,
      customerId: input.customerId ?? null,
      createdByOxyUserId: input.createdByOxyUserId,
      status: 'open',
      discountCodes: [],
      currency: input.currency,
      ...totalsColumns(input.totals),
    })
    .returning();
  const [record] = await withChildren([row], db);
  return record;
}

/**
 * Replace a draft's lines, allocations, tax lines and totals in ONE transaction.
 *
 * Every register mutation funnels through here after re-pricing; see the module
 * header for why this is a wholesale replacement rather than a diff.
 */
export async function replaceDraftPricing(
  draftId: string,
  pricing: DraftPricing,
  db: DatabaseOrTransaction = getDb(),
): Promise<DraftOrderRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<DraftOrderRecord | null> => {
    // The option values go with their lines through the FK cascade, so the three
    // deletes below cover all four child tables.
    await tx.delete(draftOrderLineItems).where(eq(draftOrderLineItems.draftOrderId, draftId));
    await tx
      .delete(draftOrderAppliedDiscounts)
      .where(eq(draftOrderAppliedDiscounts.draftOrderId, draftId));
    await tx.delete(draftOrderTaxLines).where(eq(draftOrderTaxLines.draftOrderId, draftId));

    if (pricing.lineItems.length > 0) {
      const lineRows = await tx
        .insert(draftOrderLineItems)
        .values(
          pricing.lineItems.map((line, position) => ({
            draftOrderId: draftId,
            listingId: line.listingId,
            variantId: line.variantId,
            title: line.title,
            variantTitle: line.variantTitle,
            unitPriceAmount: line.unitPrice.amount,
            unitPriceCurrency: line.unitPrice.currency,
            quantity: line.quantity,
            // Both columns present or absent together —
            // `draft_order_line_items_discount_total_complete_check`.
            discountTotalAmount: line.discountTotal?.amount ?? null,
            discountTotalCurrency: line.discountTotal?.currency ?? null,
            position,
          })),
        )
        .returning({ id: draftOrderLineItems.id });

      const optionValues = pricing.lineItems.flatMap((line, index) =>
        line.optionValues.map((option, position) => ({
          draftOrderLineItemId: lineRows[index].id,
          name: option.name,
          value: option.value,
          position,
        })),
      );
      if (optionValues.length > 0) {
        await tx.insert(draftOrderLineItemOptionValues).values(optionValues);
      }
    }

    if (pricing.appliedDiscounts.length > 0) {
      await tx.insert(draftOrderAppliedDiscounts).values(
        pricing.appliedDiscounts.map((allocation, position) => ({
          draftOrderId: draftId,
          discountId: allocation.discountId,
          code: allocation.code ?? null,
          title: allocation.title,
          valueType: allocation.valueType,
          amountAmount: allocation.amount.amount,
          amountCurrency: allocation.amount.currency,
          target: allocation.target,
          targetLineIndex: allocation.targetLineIndex ?? null,
          position,
        })),
      );
    }

    if (pricing.taxLines.length > 0) {
      await tx.insert(draftOrderTaxLines).values(
        pricing.taxLines.map((line, position) => ({
          draftOrderId: draftId,
          name: line.name,
          rateBps: line.rateBps,
          amountAmount: line.amount.amount,
          amountCurrency: line.amount.currency,
          position,
        })),
      );
    }

    const [row] = await tx
      .update(draftOrders)
      .set({ ...totalsColumns(pricing.totals), updatedAt: new Date() })
      .where(eq(draftOrders.id, draftId))
      .returning();
    if (!row) return null;

    const [record] = await withChildren([row], tx);
    return record;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** The columns a caller may patch on a draft without re-pricing it. */
export interface DraftOrderPatch {
  customerId?: string;
  discountCodes?: string[];
  note?: string;
  shippingAddress?: AddressSnapshot;
  status?: DraftOrderStatus;
}

/** Patch a draft's own columns, scoped to its store. */
export async function updateDraftOrder(
  storeId: string,
  draftId: string,
  patch: DraftOrderPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<DraftOrderRecord | null> {
  const address = patch.shippingAddress;
  const rows = await db
    .update(draftOrders)
    .set({
      ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
      ...(patch.discountCodes !== undefined ? { discountCodes: [...patch.discountCodes] } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(address !== undefined
        ? {
            shippingAddressLabel: address.label ?? null,
            shippingAddressRecipientName: address.recipientName,
            shippingAddressLine1: address.line1,
            shippingAddressLine2: address.line2 ?? null,
            shippingAddressCity: address.city,
            shippingAddressRegion: address.region ?? null,
            shippingAddressPostalCode: address.postalCode,
            shippingAddressCountry: address.country,
            shippingAddressPhone: address.phone ?? null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(draftOrders.id, draftId), eq(draftOrders.storeId, storeId)))
    .returning();
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/**
 * Mark a draft `completed` and record the order it became, ONLY IF it is still
 * open.
 *
 * The two columns move together because `draft_orders_converted_order_check`
 * requires it: a `completed` draft has a converted order and a non-completed one
 * does not, which Mongo could only hope for. Guarded on `status = 'open'` for the
 * same reason the order transition is — a second `complete` that lost the race
 * must not overwrite the first one's order id.
 *
 * @returns `false` when the guard refused, i.e. the draft was concurrently
 *   completed or cancelled.
 */
export async function markDraftConverted(
  storeId: string,
  draftId: string,
  convertedOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(draftOrders)
    .set({ status: 'completed', convertedOrderId, updatedAt: new Date() })
    .where(
      and(
        eq(draftOrders.id, draftId),
        eq(draftOrders.storeId, storeId),
        eq(draftOrders.status, 'open'),
      ),
    )
    .returning({ id: draftOrders.id });
  return rows.length > 0;
}
