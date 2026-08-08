/**
 * The point-of-sale draft: `draft_orders`, `draft_order_line_items`,
 * `draft_order_line_item_option_values`, `draft_order_applied_discounts`,
 * `draft_order_tax_lines`.
 *
 * A draft is the register's MUTABLE cart; `complete` reserves stock, freezes the
 * line snapshots and converts it into a paid `Order`. Money here is SINGLE
 * currency throughout — the draft is priced in the store's own currency
 * (`draft_orders.currency`) and only acquires a presentment side when it becomes
 * an order.
 *
 * The Mongoose model redefined the discount-allocation and tax-line
 * sub-schemas "so the two models do not import across each other". That
 * duplication does not travel: both value-set tuples are imported from
 * `orders.ts` / `merchandising.ts` here, so a change to either cannot leave the
 * POS side behind.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import type { DraftOrderStatus } from '@mercaria/shared-types';
import {
  asEnumValues,
  checkOneOf,
  currencyChecks,
  money,
  optionalAddressColumns,
  optionalMoney,
} from './columns';
import { DISCOUNT_VALUE_TYPES } from './merchandising';
import { DISCOUNT_ALLOCATION_TARGETS, orders } from './orders';
import { customers, locations, stores } from './stores';

/** `DraftOrder.status`. */
export const DRAFT_ORDER_STATUSES: readonly DraftOrderStatus[] = [
  'open',
  'completed',
  'cancelled',
];

/**
 * `draft_orders` — the POS cart that converts into a paid order.
 *
 * `discount_codes` stays a `text[]`: the codes are pinned to the draft and
 * re-applied wholesale by the pricing engine at every recompute, never queried
 * by element.
 */
export const draftOrders = pgTable(
  'draft_orders',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /**
     * Where this draft will commit stock. `restrict`, NOT `set null`: NULL
     * already means "the store's default location", so `set null` would silently
     * REROUTE an open draft's reservation to a different place rather than fail.
     *
     * `location.service.deleteLocation` therefore sees SQLSTATE 23503 when an
     * open draft still points here, and translates it into a 409 naming what to
     * reassign — the refusal is the point, so do not weaken this to `set null`.
     */
    locationId: text().references(() => locations.id, { onDelete: 'restrict' }),
    /** `restrict` for the same reason `orders.customer_id` is — NULL means walk-in. */
    customerId: text().references(() => customers.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key. The member at the register. */
    createdByOxyUserId: text().notNull(),
    status: text({ enum: asEnumValues(DRAFT_ORDER_STATUSES) }).notNull().default('open'),
    discountCodes: text().array().notNull().default(sql`'{}'::text[]`),
    ...optionalAddressColumns('shippingAddress'),

    // `totals` — five SINGLE-currency amounts, in `currency` below.
    ...money('totalsSubtotal'),
    ...money('totalsDiscountTotal'),
    ...money('totalsTax'),
    ...money('totalsShipping'),
    ...money('totalsGrandTotal'),

    /** The currency the whole draft is priced in. */
    currency: text().notNull(),
    note: text(),
    /**
     * The order this draft became. `restrict`: it is the audit link from a
     * register sale to its receipt, and nothing deletes an order.
     */
    convertedOrderId: text().references(() => orders.id, { onDelete: 'restrict' }),
    /** Sparse-unique: a replayed `complete` converges instead of double-creating. */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('draft_orders_status_check', t.status, DRAFT_ORDER_STATUSES),
    ...currencyChecks('draft_orders', [
      t.currency,
      t.totalsSubtotalCurrency,
      t.totalsDiscountTotalCurrency,
      t.totalsTaxCurrency,
      t.totalsShippingCurrency,
      t.totalsGrandTotalCurrency,
    ]),
    // A completed draft has an order; an open or cancelled one does not. Mongo
    // could only hope for this; here `complete`'s whole postcondition is stated.
    check(
      'draft_orders_converted_order_check',
      sql`(${t.status} = 'completed') = (${t.convertedOrderId} is not null)`,
    ),
    index('draft_orders_store_id_status_created_at_idx').on(
      t.storeId,
      t.status,
      t.createdAt.desc(),
    ),
    // Reverse lookup from a converted order back to its draft. UNIQUE, not just
    // an index: one draft becomes one order, and two drafts claiming the same
    // order would mean `complete` ran twice — exactly what the idempotency key
    // exists to prevent, now also unrepresentable.
    uniqueIndex('draft_orders_converted_order_id_key')
      .on(t.convertedOrderId)
      .where(sql`${t.convertedOrderId} is not null`),
    uniqueIndex('draft_orders_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/**
 * `draft_order_line_items` — a line on the register, priced live from the
 * catalogue until `complete` freezes it.
 *
 * `listing_id` and `variant_id` carry no foreign key here for a different reason
 * than the order line's: an OPEN draft's references are live rather than
 * historical, but a `completed` draft's are a frozen record beside the order it
 * produced. One column cannot be both constrained and not, and the historical
 * case is the one that must survive.
 */
export const draftOrderLineItems = pgTable(
  'draft_order_line_items',
  {
    id: generatedId(),
    draftOrderId: text()
      .notNull()
      .references(() => draftOrders.id, { onDelete: 'cascade' }),
    /** Live while open, a snapshot once completed — deliberately no foreign key. */
    listingId: text().notNull(),
    /** Live while open, a snapshot once completed — deliberately no foreign key. */
    variantId: text().notNull(),
    title: text().notNull(),
    variantTitle: text().notNull(),
    ...money('unitPrice'),
    quantity: integer().notNull(),
    /** Both columns absent together when the pricing engine allocated nothing. */
    ...optionalMoney('discountTotal'),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('draft_order_line_items', [t.unitPriceCurrency, t.discountTotalCurrency]),
    check('draft_order_line_items_quantity_check', sql`${t.quantity} > 0`),
    check(
      'draft_order_line_items_discount_total_complete_check',
      sql`num_nonnulls(${t.discountTotalAmount}, ${t.discountTotalCurrency}) in (0, 2)`,
    ),
    index('draft_order_line_items_draft_order_id_position_idx').on(t.draftOrderId, t.position),
  ],
);

/** `draft_order_line_item_option_values` — the `{name, value}` pairs on a draft line. */
export const draftOrderLineItemOptionValues = pgTable(
  'draft_order_line_item_option_values',
  {
    id: generatedId(),
    draftOrderLineItemId: text()
      .notNull()
      .references(() => draftOrderLineItems.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    value: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('draft_order_line_item_option_values_line_item_id_position_idx').on(
      t.draftOrderLineItemId,
      t.position,
    ),
  ],
);

/** `draft_order_applied_discounts` — one discount's contribution to the draft. */
export const draftOrderAppliedDiscounts = pgTable(
  'draft_order_applied_discounts',
  {
    id: generatedId(),
    draftOrderId: text()
      .notNull()
      .references(() => draftOrders.id, { onDelete: 'cascade' }),
    /** SNAPSHOT provenance — deliberately no foreign key; discounts get deleted. */
    discountId: text().notNull(),
    code: text(),
    title: text().notNull(),
    valueType: text({ enum: asEnumValues(DISCOUNT_VALUE_TYPES) }).notNull(),
    ...money('amount'),
    target: text({ enum: asEnumValues(DISCOUNT_ALLOCATION_TARGETS) }).notNull(),
    targetLineIndex: integer(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('draft_order_applied_discounts_value_type_check', t.valueType, DISCOUNT_VALUE_TYPES),
    checkOneOf(
      'draft_order_applied_discounts_target_check',
      t.target,
      DISCOUNT_ALLOCATION_TARGETS,
    ),
    ...currencyChecks('draft_order_applied_discounts', [t.amountCurrency]),
    check(
      'draft_order_applied_discounts_target_line_check',
      sql`(${t.target} = 'line') = (${t.targetLineIndex} is not null)`,
    ),
    index('draft_order_applied_discounts_draft_order_id_position_idx').on(
      t.draftOrderId,
      t.position,
    ),
  ],
);

/** `draft_order_tax_lines` — one applied rate's contribution to the draft. */
export const draftOrderTaxLines = pgTable(
  'draft_order_tax_lines',
  {
    id: generatedId(),
    draftOrderId: text()
      .notNull()
      .references(() => draftOrders.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Basis points — 800 = 8%. */
    rateBps: integer().notNull(),
    ...money('amount'),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('draft_order_tax_lines', [t.amountCurrency]),
    index('draft_order_tax_lines_draft_order_id_position_idx').on(t.draftOrderId, t.position),
  ],
);
