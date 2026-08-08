/**
 * The immutable commerce record: `orders`, `order_items`,
 * `order_item_option_values`, `order_status_history`,
 * `order_applied_discounts`, `order_tax_lines`, `refunds`,
 * `refund_line_items`.
 *
 * ## The rule that governs every foreign key in this file
 *
 * An order is the record of what was actually sold, and a buyer or a tax
 * authority can be asked about it years later. So a line's `listing_id`,
 * `variant_id` and `location_id` carry NO foreign key: they are SNAPSHOTS'
 * provenance, and the line already holds a frozen `title`, `variant_title`,
 * `unit_price` and image alongside them. Constraining them would mean either
 * blocking `catalog-write.removeVariant` (which deletes variants today) or
 * destroying order history when it runs. Both are worse than an unconstrained
 * historical reference, and `CONVENTIONS.md` decides this case explicitly.
 *
 * The CHILD relations — a line to its order, a status event to its order — do
 * cascade: those rows exist only to point at the order and are meaningless
 * without it.
 *
 * ## Where the money is DUAL and where it is SINGLE
 *
 * Every TRANSACTED amount is a `DualMoney` and therefore four columns: line
 * `unit_price` / `line_total` / `discount_total`, all five order `totals`,
 * `shipping.cost`, refund line amounts and `total_refunded`.
 *
 * The discount and tax BREAKDOWN lines are deliberately SINGLE-currency shop
 * amounts. They are the settlement and refund basis, and giving them a
 * presentment side would invite a refund computed against it.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONNECTOR_PROVIDER_IDS,
  type OrderSellerType,
  type OrderSourceChannel,
  type OrderStatus,
  type PaymentInfo,
  type RefundStatus,
  type RefundType,
  type ShippingMethod,
} from '@mercaria/shared-types';
import {
  addressColumns,
  asEnumValues,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  dualMoney,
  money,
  optionalDualMoney,
  optionalMoney,
} from './columns';
import { connections } from './connectors';
import { DISCOUNT_VALUE_TYPES } from './merchandising';
import { customers, stores } from './stores';

/** `Order.status` — `ORDER_STATUSES` in `models/order.ts`. */
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
];

/** `Order.payment.status` — `PAYMENT_STATUSES`. */
export const PAYMENT_STATUSES: readonly PaymentInfo['status'][] = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
  'failed',
];

/** `Order.payment.provider` — `PAYMENT_PROVIDERS`. */
export const PAYMENT_PROVIDERS: readonly PaymentInfo['provider'][] = ['oxy_pay', 'external'];

/** `Order.shipping.method` — `SHIPPING_METHODS`. */
export const SHIPPING_METHODS: readonly ShippingMethod[] = ['standard', 'express', 'pickup'];

/** `Order.sellerType` — `SELLER_TYPES`. */
export const ORDER_SELLER_TYPES: readonly OrderSellerType[] = ['user', 'store'];

/** `Order.sourceChannel` — `SOURCE_CHANNELS`. */
export const ORDER_SOURCE_CHANNELS: readonly OrderSourceChannel[] = ['storefront', 'pos', 'draft'];

/** A discount allocation's target — `['order', 'line']` in `models/order.ts`. */
export const DISCOUNT_ALLOCATION_TARGETS = ['order', 'line'] as const;

/** `Refund.type` — `REFUND_TYPES` in `models/refund.ts`. */
export const REFUND_TYPES: readonly RefundType[] = ['refund', 'return'];

/** `Refund.status` — `REFUND_STATUSES`. */
export const REFUND_STATUSES: readonly RefundStatus[] = [
  'requested',
  'approved',
  'restocked',
  'refunded',
  'rejected',
  'cancelled',
];

/**
 * `orders` — one seller's immutable portion of a checkout.
 *
 * A multi-seller cart splits into one order per seller, all sharing a
 * `checkout_group_id`.
 *
 * `moderation_hold` is deliberately SEPARATE from `status`: a freeze is not a
 * lifecycle state and must not consume one. A `frozen` status would mean every
 * transition, notification and report query had to learn about it, and
 * unfreezing would have to guess which status to return to.
 */
export const orders = pgTable(
  'orders',
  {
    id: generatedId(),
    /** `MRC-000123` — printed and emailed, so it outlives this database. */
    orderNumber: text().notNull(),
    /** An Oxy account id — no foreign key. */
    buyerOxyUserId: text().notNull(),
    sellerType: text({ enum: asEnumValues(ORDER_SELLER_TYPES) }).notNull(),
    /** An Oxy account id — no foreign key. Set iff `sellerType = 'user'`. */
    sellerOxyUserId: text(),
    /**
     * Set iff `sellerType = 'store'`. `restrict`: an order is the record of a
     * sale and cannot be orphaned from the store that made it — and nothing
     * deletes a store today, so this never fires.
     */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /**
     * `restrict`, NOT `set null`. NULL here already means "no customer record
     * attached" (every storefront order), so `set null` would silently reclassify
     * a store's customer order as an anonymous one rather than mark it orphaned.
     */
    customerId: text().references(() => customers.id, { onDelete: 'restrict' }),
    sourceChannel: text({ enum: asEnumValues(ORDER_SOURCE_CHANNELS) })
      .notNull()
      .default('storefront'),

    // `source` — connector provenance, flattened. Only on externally-synced orders.
    sourceConnectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    sourceProvider: text({ enum: asEnumValues(CONNECTOR_PROVIDER_IDS) }),
    /** The external platform's own order id — a foreign system's key. */
    sourceExternalId: text(),
    sourceExternalUpdatedAt: timestamptz(),

    /**
     * The shipping destination, SNAPSHOTTED so a later edit of the saved address
     * cannot mutate a placed order. Required on every order, hence NOT NULL.
     */
    ...addressColumns('shippingAddress'),

    // `shipping` — the chosen method, its label, its cost and a tracking number.
    shippingMethod: text({ enum: asEnumValues(SHIPPING_METHODS) }).notNull(),
    shippingLabel: text().notNull(),
    ...dualMoney('shippingCost'),
    /** Mongoose `default: null` — NULL means "not yet dispatched", not "unknown". */
    shippingTrackingNumber: text(),

    // `totals` — five DualMoney amounts, twenty columns. Flat, because reports
    // `$match` the shop currency and sum the shop amount, and that filter has to
    // be an indexable predicate on a real column.
    ...dualMoney('totalsSubtotal'),
    ...dualMoney('totalsDiscountTotal'),
    ...dualMoney('totalsShipping'),
    ...dualMoney('totalsTax'),
    ...dualMoney('totalsGrandTotal'),

    // `fxRate` — the shop→presentment snapshot the dual amounts were formed with,
    // kept so the conversion is reproducible after rates move.
    //
    // Both sides are typed from `CURRENCY_CODE_VALUES`, the same tuple their
    // `currencyChecks` entry below is rendered from. `text({ enum })` emits no
    // DDL — it is a TypeScript narrowing only — so this changes no migration; what
    // it changes is that a serializer reading `fxRateFrom` gets `CurrencyCode`
    // rather than `string`, which is what the CHECK already promises.
    fxRateFrom: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateTo: text({ enum: CURRENCY_CODE_VALUES }),
    /** A conversion rate, genuinely fractional — the same IEEE-754 double Mongo held. */
    fxRateRate: doublePrecision(),
    /**
     * An ISO-8601 instant, stored as TEXT because `FxRateSnapshot.asOf` is
     * declared `string` in `@mercaria/shared-types` and ships to clients that way.
     * A `timestamptz` would change the wire format on every read for no caller's
     * benefit — the exact `db.execute` hazard `CONVENTIONS.md` warns about, only
     * self-inflicted.
     */
    fxRateAsOf: text(),

    // `settlement` — the shop→FAIR snapshot, present once the order is paid, and
    // the only remaining `convertToFair` in the system. Nullable: an unpaid order
    // has not settled. Flattened as `settlement_amount`/`settlement_currency`
    // rather than the source's nested `settlement.amount.{amount,currency}`,
    // which would spell a column `settlement_amount_amount`.
    ...optionalMoney('settlement'),
    /** The shop→FAIR rate used, kept so the payout figure is auditable. */
    settlementRate: doublePrecision(),
    /** An ISO-8601 instant as TEXT — same reason as `fxRateAsOf`. */
    settlementAsOf: text(),

    status: text({ enum: asEnumValues(ORDER_STATUSES) }).notNull().default('pending_payment'),

    // `payment` — a fixed four-field object, flattened. `reference` is the Oxy Pay
    // (or external provider's) transaction id and is a PROTECTED column.
    paymentStatus: text({ enum: asEnumValues(PAYMENT_STATUSES) }).notNull().default('unpaid'),
    paymentProvider: text({ enum: asEnumValues(PAYMENT_PROVIDERS) }).notNull().default('oxy_pay'),
    paymentReference: text(),
    paymentPaidAt: timestamptz(),

    checkoutGroupId: text(),
    /** Sparse-unique: a replayed checkout converges instead of duplicating. */
    idempotencyKey: text(),
    /**
     * A moderation freeze. While true, `order.service.transition` refuses to
     * advance this order. Set by a `freeze_transaction` decision, cleared by a
     * later `restore`.
     */
    moderationHold: boolean(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('orders_seller_type_check', t.sellerType, ORDER_SELLER_TYPES),
    checkOneOf('orders_source_channel_check', t.sourceChannel, ORDER_SOURCE_CHANNELS),
    checkOneOf('orders_source_provider_check', t.sourceProvider, CONNECTOR_PROVIDER_IDS),
    checkOneOf('orders_shipping_method_check', t.shippingMethod, SHIPPING_METHODS),
    checkOneOf('orders_status_check', t.status, ORDER_STATUSES),
    checkOneOf('orders_payment_status_check', t.paymentStatus, PAYMENT_STATUSES),
    checkOneOf('orders_payment_provider_check', t.paymentProvider, PAYMENT_PROVIDERS),
    ...currencyChecks('orders', [
      t.shippingCostShopCurrency,
      t.shippingCostPresentmentCurrency,
      t.totalsSubtotalShopCurrency,
      t.totalsSubtotalPresentmentCurrency,
      t.totalsDiscountTotalShopCurrency,
      t.totalsDiscountTotalPresentmentCurrency,
      t.totalsShippingShopCurrency,
      t.totalsShippingPresentmentCurrency,
      t.totalsTaxShopCurrency,
      t.totalsTaxPresentmentCurrency,
      t.totalsGrandTotalShopCurrency,
      t.totalsGrandTotalPresentmentCurrency,
      t.settlementCurrency,
      t.fxRateFrom,
      t.fxRateTo,
    ]),
    // The seller side mirrors the listing owner: exactly one of the two is set.
    check(
      'orders_seller_exclusivity_check',
      sql`(${t.sellerType} = 'user' and ${t.sellerOxyUserId} is not null and ${t.storeId} is null)
          or (${t.sellerType} = 'store' and ${t.storeId} is not null and ${t.sellerOxyUserId} is null)`,
    ),
    // A settlement snapshot is complete or absent — never a FAIR amount with no
    // rate to explain it, which would be an unauditable payout figure.
    check(
      'orders_settlement_complete_check',
      sql`num_nonnulls(${t.settlementAmount}, ${t.settlementCurrency}, ${t.settlementRate}, ${t.settlementAsOf}) in (0, 4)`,
    ),
    check(
      'orders_fx_rate_complete_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateAsOf}) in (0, 4)`,
    ),

    uniqueIndex('orders_order_number_key').on(t.orderNumber),
    index('orders_buyer_created_at_idx').on(t.buyerOxyUserId, t.createdAt.desc()),
    index('orders_store_id_status_created_at_idx').on(t.storeId, t.status, t.createdAt.desc()),
    index('orders_store_id_customer_id_created_at_idx').on(
      t.storeId,
      t.customerId,
      t.createdAt.desc(),
    ),
    index('orders_seller_oxy_user_id_status_created_at_idx').on(
      t.sellerOxyUserId,
      t.status,
      t.createdAt.desc(),
    ),
    index('orders_checkout_group_id_idx').on(t.checkoutGroupId),
    index('orders_payment_status_created_at_idx').on(t.paymentStatus, t.createdAt),
    // The expire-reservations sweep: pending_payment orders older than a cutoff.
    index('orders_status_created_at_idx').on(t.status, t.createdAt),
    uniqueIndex('orders_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // One Mercaria order per (connection, external order) — a hard constraint, so
    // a redelivered order webhook cannot create a second copy.
    uniqueIndex('orders_store_id_source_key')
      .on(t.storeId, t.sourceConnectionId, t.sourceExternalId)
      .where(sql`${t.sourceExternalId} is not null`),
  ],
);

/**
 * `order_items` — one purchased line, frozen at checkout.
 *
 * `listing_id`, `variant_id` and `location_id` are unconstrained historical
 * references; see this file's docblock.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    listingId: text().notNull(),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    variantId: text().notNull(),
    title: text().notNull(),
    variantTitle: text().notNull(),
    imageUrl: text(),
    ...dualMoney('unitPrice'),
    quantity: integer().notNull(),
    ...dualMoney('lineTotal'),
    /** All four columns absent together on an un-discounted line. */
    ...optionalDualMoney('discountTotal'),
    /** The POS location this line committed stock at. Snapshot — no foreign key. */
    locationId: text(),
    /** Preserves the line's order within the order, which Mongo got from the array. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('order_items', [
      t.unitPriceShopCurrency,
      t.unitPricePresentmentCurrency,
      t.lineTotalShopCurrency,
      t.lineTotalPresentmentCurrency,
      t.discountTotalShopCurrency,
      t.discountTotalPresentmentCurrency,
    ]),
    check('order_items_quantity_check', sql`${t.quantity} > 0`),
    // A `DualMoney` is present in all four columns or in none.
    check(
      'order_items_discount_total_complete_check',
      sql`num_nonnulls(${t.discountTotalShopAmount}, ${t.discountTotalShopCurrency}, ${t.discountTotalPresentmentAmount}, ${t.discountTotalPresentmentCurrency}) in (0, 4)`,
    ),
    index('order_items_order_id_position_idx').on(t.orderId, t.position),
    // Sales reporting groups purchased lines by product.
    index('order_items_listing_id_idx').on(t.listingId),
    index('order_items_variant_id_idx').on(t.variantId),
  ],
);

/**
 * `order_item_option_values` — the `{name, value}` pairs printed on the receipt.
 *
 * A child table rather than two parallel `text[]` columns, which are two
 * representations of one fact and can disagree in LENGTH — the divergence a
 * relational shape makes unrepresentable. Not `jsonb` either: the shape is
 * entirely known, which is the bar `CONVENTIONS.md` sets for a real table.
 */
export const orderItemOptionValues = pgTable(
  'order_item_option_values',
  {
    id: generatedId(),
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    value: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('order_item_option_values_order_item_id_position_idx').on(t.orderItemId, t.position),
  ],
);

/**
 * `order_status_history` — the append-only lifecycle trail.
 *
 * `timestamps: true` is NOT ported: the source sub-document had only its own
 * `at`, and the ABSENCE of `updated_at` is the append-only contract. `created_at`
 * is not added either — `at` already is it, and two birth timestamps that can
 * disagree is exactly the redundancy this port removes.
 */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    status: text({ enum: asEnumValues(ORDER_STATUSES) }).notNull(),
    at: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. NULL for a system transition. */
    byOxyUserId: text(),
    note: text(),
  },
  (t) => [
    checkOneOf('order_status_history_status_check', t.status, ORDER_STATUSES),
    index('order_status_history_order_id_at_idx').on(t.orderId, t.at),
  ],
);

/**
 * `order_applied_discounts` — one discount's contribution, persisted so a refund
 * can be computed against exactly what was charged.
 *
 * `amount` is a SINGLE-currency shop `Money`. `discount_id` carries no foreign
 * key: like the line's `listing_id` it is historical provenance, and a discount
 * IS deleted by `discount.service.deleteDiscount`, so a constraint would either
 * block that or erase the allocation that explains an old order's total.
 */
export const orderAppliedDiscounts = pgTable(
  'order_applied_discounts',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** SNAPSHOT provenance — deliberately no foreign key; discounts get deleted. */
    discountId: text().notNull(),
    code: text(),
    title: text().notNull(),
    /**
     * The discount's `valueType`. Free-form `String` in Mongo, but its only
     * producer copies `discount.valueType`, which is itself a closed set — so the
     * CHECK here is a tightening, and a deliberate one.
     */
    valueType: text({ enum: asEnumValues(DISCOUNT_VALUE_TYPES) }).notNull(),
    ...money('amount'),
    target: text({ enum: asEnumValues(DISCOUNT_ALLOCATION_TARGETS) }).notNull(),
    /** Which line, when `target = 'line'` — an INDEX into the order's own lines. */
    targetLineIndex: integer(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('order_applied_discounts_value_type_check', t.valueType, DISCOUNT_VALUE_TYPES),
    checkOneOf('order_applied_discounts_target_check', t.target, DISCOUNT_ALLOCATION_TARGETS),
    ...currencyChecks('order_applied_discounts', [t.amountCurrency]),
    // A line-targeted allocation must say WHICH line; an order-targeted one must not.
    check(
      'order_applied_discounts_target_line_check',
      sql`(${t.target} = 'line') = (${t.targetLineIndex} is not null)`,
    ),
    index('order_applied_discounts_order_id_position_idx').on(t.orderId, t.position),
  ],
);

/** `order_tax_lines` — one applied rate's contribution, a SINGLE-currency shop amount. */
export const orderTaxLines = pgTable(
  'order_tax_lines',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Basis points — 800 = 8%. */
    rateBps: integer().notNull(),
    ...money('amount'),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('order_tax_lines', [t.amountCurrency]),
    index('order_tax_lines_order_id_position_idx').on(t.orderId, t.position),
  ],
);

/**
 * `refunds` — money returned for part or all of a paid order.
 *
 * `refund.service` is the SOLE authority for refund-driven restock: it restocks
 * explicitly per line and sets the order status directly, never through
 * `order.service.transition`, so a refund can never double-restock.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: generatedId(),
    /**
     * `restrict`: a refund without its order is an unexplained outbound payment,
     * and nothing deletes an order.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key. */
    sellerOxyUserId: text(),
    type: text({ enum: asEnumValues(REFUND_TYPES) }).notNull().default('refund'),
    status: text({ enum: asEnumValues(REFUND_STATUSES) }).notNull().default('refunded'),
    reason: text(),
    /** All four absent together when no shipping was refunded. */
    ...optionalDualMoney('refundShipping'),
    ...dualMoney('totalRefunded'),
    restockedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    processedByOxyUserId: text(),
    /** `RMA-000123` — sparse-unique; not every refund carries one. */
    rmaNumber: text(),
    /** Sparse-unique: a replayed submit converges instead of double-restocking. */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('refunds_type_check', t.type, REFUND_TYPES),
    checkOneOf('refunds_status_check', t.status, REFUND_STATUSES),
    ...currencyChecks('refunds', [
      t.refundShippingShopCurrency,
      t.refundShippingPresentmentCurrency,
      t.totalRefundedShopCurrency,
      t.totalRefundedPresentmentCurrency,
    ]),
    check(
      'refunds_refund_shipping_complete_check',
      sql`num_nonnulls(${t.refundShippingShopAmount}, ${t.refundShippingShopCurrency}, ${t.refundShippingPresentmentAmount}, ${t.refundShippingPresentmentCurrency}) in (0, 4)`,
    ),
    index('refunds_order_id_created_at_idx').on(t.orderId, t.createdAt.desc()),
    index('refunds_store_id_status_created_at_idx').on(t.storeId, t.status, t.createdAt.desc()),
    uniqueIndex('refunds_rma_number_key').on(t.rmaNumber).where(sql`${t.rmaNumber} is not null`),
    uniqueIndex('refunds_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/**
 * `refund_line_items` — one refunded line: variant, quantity, amount, restock.
 *
 * `variant_id` and `location_id` are historical references with no foreign key,
 * for the same reason the order line's are.
 */
export const refundLineItems = pgTable(
  'refund_line_items',
  {
    id: generatedId(),
    refundId: text()
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    variantId: text().notNull(),
    quantity: integer().notNull(),
    ...dualMoney('amount'),
    restock: boolean().notNull().default(false),
    /** Where the units were restocked. Snapshot — no foreign key. */
    locationId: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('refund_line_items', [t.amountShopCurrency, t.amountPresentmentCurrency]),
    check('refund_line_items_quantity_check', sql`${t.quantity} > 0`),
    index('refund_line_items_refund_id_position_idx').on(t.refundId, t.position),
  ],
);
