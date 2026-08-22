/**
 * The immutable commerce record: `orders`, `order_items`,
 * `order_item_option_values`, `order_status_history`,
 * `order_applied_discounts`, `order_tax_lines`, `refunds`,
 * `refund_line_items`.
 *
 * ## "Immutable" here means ENFORCED, table by table
 *
 * That sentence was prose for a long time and the database backed almost none
 * of it. #868 enforced the `refunds` half and #375 the order half, so each
 * table below now says which shape it carries — and the declared half, with the
 * reason for every column left open, is `db/commerceHistoryDispositions.ts`,
 * which `commerce-history-immutability.realdb.test.ts` EXECUTES against a real
 * server. Four tables refuse every UPDATE; `orders` and `order_items` move and
 * are frozen by COLUMN. NOTHING refuses a DELETE, because every child cascades
 * from `orders` and a refusal would break the cascade rather than protect
 * anything.
 *
 * If you are adding a column here, it joins no freeze by default. Say what it
 * is in that ledger; the census fails the build until you do.
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
 * amounts. They are the merchant accounting and refund basis, and giving them a
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
  CONDITION_ASSERTIONS,
  CONNECTOR_PROVIDER_IDS,
  ITEM_CONDITION_KEYS,
  ORDER_ACTOR_KINDS,
  ORDER_BUYER_ORIGINS,
  ORDER_COMMERCIAL_ROLES,
  ORDER_PAYMENT_STATUSES,
  ORDER_SELLER_TYPES as SHARED_ORDER_SELLER_TYPES,
  PAYMENT_PROVIDER_IDS,
  REFUND_PROVIDER_STATES,
  REFUND_REVERSAL_STATES,
  type OrderSourceChannel,
  type OrderStatus,
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
import { guestCheckouts } from './guests';
import { DISCOUNT_VALUE_TYPES } from './merchandising';
import { customers, stores } from './stores';

/** `Order.status`. */
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

/** `Order.shipping.method` — `SHIPPING_METHODS`. */
export const SHIPPING_METHODS: readonly ShippingMethod[] = ['standard', 'express', 'pickup'];

/**
 * `Order.sellerType` — `SELLER_TYPES`, re-exported from the shared tuple.
 *
 * It lived here as a local literal until #123 gave `platform` a meaning outside
 * this package (the fee domain's `eligible_seller_type` scope reads it, and so
 * does every DTO). One tuple, in `@mercaria/shared-types`, is what keeps the
 * column's CHECK and the TypeScript union from drifting apart.
 */
export const ORDER_SELLER_TYPES = SHARED_ORDER_SELLER_TYPES;

/** `Order.sourceChannel` — `SOURCE_CHANNELS`. */
export const ORDER_SOURCE_CHANNELS: readonly OrderSourceChannel[] = ['storefront', 'pos', 'draft'];

/** A discount allocation's target. */
export const DISCOUNT_ALLOCATION_TARGETS = ['order', 'line'] as const;

/** `Refund.type`. */
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
 * `orders` — one seller's portion of a checkout, whose SNAPSHOT half is frozen.
 *
 * A multi-seller cart splits into one order per seller, all sharing a
 * `checkout_group_id`.
 *
 * ## Which half is frozen, and which moves
 *
 * `orders_snapshot_immutable` (#375) refuses a rewrite of what was SOLD: the
 * order number, the group, the idempotency key, who sold it, the commercial
 * role, the source channel, the destination address snapshot, the chosen
 * shipping method and cost, all twenty `totals_*` columns and the five
 * `fx_rate_*` columns. `orders_buyer_origin_immutable` (#106) governs the four
 * buyer-identity columns separately, because it must permit
 * `claimed_by_oxy_user_id` value → NULL (an audited unclaim) and the shared
 * write-once guard would refuse that.
 *
 * What legitimately moves: `status`, the payment linkage
 * (`payment_status`, `payment_paid_at`, `payment_id`, `payment_provider`,
 * `payment_reference`), `shipping_tracking_number`, `moderation_hold`, the
 * claim pair, the four connector-sync `source_*` columns, and `updated_at`.
 * `created_at` also stays open, deliberately: it is the RESERVATION CLOCK, and
 * `services/__tests__/checkout.stripe.realdb.test.ts` moves it to travel past
 * the reservation TTL, which nothing else can express.
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
    /**
     * An Oxy account id — no foreign key.
     *
     * NULLABLE since #105: a guest-origin order has no Oxy account behind it,
     * and the alternative — a synthetic id in this column — is precisely the
     * mistake ADR 0003's context section refuses (connector imports already
     * smuggle `ext:<provider>:<id>` here, distinguishable only by a prefix
     * nothing enforces). The column keeps its exact meaning for `'oxy'` orders:
     * the ORIGIN owner. `orders_buyer_identity_check` below is what makes the
     * nullability safe rather than merely permitted.
     */
    buyerOxyUserId: text(),
    /**
     * Where this order's buyer identity came from (ADR 0003 D6) — `oxy`,
     * `guest` or `external`.
     *
     * `default('oxy')` is what let the migration add it to a table of existing
     * rows without a rewrite, and it is also the honest value for every one of
     * them. IMMUTABLE after insert, enforced by a trigger rather than a
     * convention: a claim (#109) records a later Oxy owner in its own column
     * and must never rewrite this one, so "who placed it" and "who owns it now"
     * stay two facts (I7).
     */
    buyerOrigin: text({ enum: asEnumValues(ORDER_BUYER_ORIGINS) }).notNull().default('oxy'),
    /**
     * The contact identity for a guest-origin order (ADR 0003 D4). Set iff
     * `buyer_origin = 'guest'`.
     *
     * A REAL foreign key, unlike every buyer/seller id column above, and the
     * difference is the whole rule: `guest_checkouts` is a Mercaria table, so
     * Mercaria can enforce the reference. `restrict`, because an order is the
     * record of a sale and must never be orphaned from the contact it was
     * placed with — anonymization (D15) empties the contact COLUMNS and keeps
     * the row for exactly this reason.
     */
    buyerGuestCheckoutId: text().references(() => guestCheckouts.id, { onDelete: 'restrict' }),
    /**
     * The LATER Oxy owner of a guest-origin order (ADR 0003 D6, #106).
     *
     * Secondary ownership, never a rewrite of history: `buyer_origin` stays
     * `'guest'` and this column answers a different question — whose account
     * may now read, list and cancel the order. Two questions, two columns, and
     * `orders_buyer_identity_check` below refuses this one on any origin but
     * `'guest'`, so an `oxy` order can never acquire a second owner and an
     * `'external'` import can never acquire a first.
     *
     * An Oxy account id, so no foreign key (Oxy owns identity), and #109's
     * claim service is its ONLY writer. There is deliberately no code path that
     * derives a claimant from a matching email: invariant I6 is held by the
     * absence of such a query plus the trigger, not by a review comment.
     */
    claimedByOxyUserId: text(),
    /**
     * When the claim was made. Present EXACTLY with `claimed_by_oxy_user_id` —
     * a claimant with no timestamp is an unauditable ownership change, and a
     * timestamp with no claimant is a claim by nobody.
     */
    claimedAt: timestamptz(),
    sellerType: text({ enum: asEnumValues(ORDER_SELLER_TYPES) }).notNull(),
    /**
     * The commercial model this order was sold under — ADR 0004 D1 (#123).
     *
     * NOT NULL with a `connected_marketplace` default, and the default is what
     * let the migration fill every existing row without a rewrite. It is not a
     * licence for a new writer to omit it: `checkout.service` states the role
     * explicitly per group, exactly as it states `buyerOrigin`, because a
     * writer that forgot would silently classify a retail sale as a
     * marketplace one and hand it to commission arithmetic.
     *
     * Frozen by `orders_snapshot_immutable` (#375).
     *
     * This used to read "immutable in practice rather than by trigger", resting
     * on `orders_commercial_role_seller_check` refusing "the only value change
     * that could matter (a role move without the matching seller-type move)".
     * That was measured and it is FALSE: the CHECK refuses a move to
     * `informational` (23514), and then ACCEPTS a move to `mercaria_retail`
     * made TOGETHER with the matching `seller_type` move. A CHECK constrains
     * VALUES; it says nothing about rewriting one. And the change it admitted
     * is precisely the one that matters — it reclassifies a marketplace sale as
     * a Mercaria-retail one, which is the input ADR 0004 D7's commission
     * arithmetic reads on every posting.
     */
    commercialRole: text({ enum: asEnumValues(ORDER_COMMERCIAL_ROLES) })
      .notNull()
      .default('connected_marketplace'),
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
    /** NULL means "not yet dispatched", not "unknown". */
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
     * What quoted the rate: an FX provider id, a connector provider id when the
     * rate was reconstructed from an external platform's own amounts, or
     * `'identity'` for a same-currency order. Free `text`, deliberately NOT a
     * closed set with a CHECK — the sources are deployment configuration, and a
     * CHECK here would make adding an FX provider a migration.
     */
    fxRateProvider: text(),
    /**
     * An ISO-8601 instant, stored as TEXT because `FxRateSnapshot.asOf` is
     * declared `string` in `@mercaria/shared-types` and ships to clients that way.
     * A `timestamptz` would change the wire format on every read for no caller's
     * benefit — the exact `db.execute` hazard `CONVENTIONS.md` warns about, only
     * self-inflicted.
     */
    fxRateAsOf: text(),

    // The `settlement_*` columns that used to sit here are GONE, dropped by the
    // `post` migration that landed the payment domain.
    //
    // They held a shop→FAIR snapshot captured when an order was paid, from a
    // model in which FAIR was the mandatory settlement currency. Their
    // replacement is `payments.platform_*` plus its rate snapshot: which
    // currency a payment settles in is a property of the payment PROVIDER, and
    // now lives with the payment rather than on every order (ADR 0001 D6/D8).

    status: text({ enum: asEnumValues(ORDER_STATUSES) }).notNull().default('pending_payment'),

    // `payment` — the buyer-safe projection, flattened. `reference` is the
    // provider's own transaction id and is a PROTECTED column. Everything else a
    // payment knows — amounts, attempts, provider events, ledger entries,
    // transfers, payouts — lives in the payment domain and is reached through
    // `payment_id`, never copied here (#45 invariant 5).
    paymentStatus: text({ enum: asEnumValues(ORDER_PAYMENT_STATUSES) })
      .notNull()
      .default('unpaid'),
    /**
     * NULLABLE, with no default. A freshly checked-out order has reserved stock
     * and no payment at all, and the retired `oxy_pay` default asserted a rail
     * for it that did not exist. Absence is the honest representation of "no
     * payment yet"; the provider appears when a payment does.
     */
    paymentProvider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }),
    paymentReference: text(),
    paymentPaidAt: timestamptz(),
    /**
     * The payment aggregate funding this order, once one exists.
     *
     * One payment covers a whole checkout group (ADR 0001 D4), so sibling orders
     * share this value — it is a many-to-one link, not a one-to-one, and the
     * uniqueness that matters lives on `payments.checkout_group_id`.
     *
     * No foreign key, and not because of the migration window that originally
     * justified it: a financial record must be writable independently of the
     * commerce record it names. `db/deferredForeignKeys.ts` carries the reason.
     */
    paymentId: text(),

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
    checkOneOf('orders_buyer_origin_check', t.buyerOrigin, ORDER_BUYER_ORIGINS),
    checkOneOf('orders_seller_type_check', t.sellerType, ORDER_SELLER_TYPES),
    checkOneOf('orders_commercial_role_check', t.commercialRole, ORDER_COMMERCIAL_ROLES),
    checkOneOf('orders_source_channel_check', t.sourceChannel, ORDER_SOURCE_CHANNELS),
    checkOneOf('orders_source_provider_check', t.sourceProvider, CONNECTOR_PROVIDER_IDS),
    checkOneOf('orders_shipping_method_check', t.shippingMethod, SHIPPING_METHODS),
    checkOneOf('orders_status_check', t.status, ORDER_STATUSES),
    checkOneOf('orders_payment_status_check', t.paymentStatus, ORDER_PAYMENT_STATUSES),
    checkOneOf('orders_payment_provider_check', t.paymentProvider, PAYMENT_PROVIDER_IDS),
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
      t.fxRateFrom,
      t.fxRateTo,
    ]),
    /**
     * The BUYER side of the same exclusivity idea (ADR 0003 D6, #105).
     *
     * Three disjoint shapes, and the point of writing it as one CHECK rather
     * than three nullable columns and a hope is that the illegal combinations
     * are the dangerous ones: a guest order carrying an `buyer_oxy_user_id` is
     * invariant I1 broken at the storage layer, and an `oxy` order carrying a
     * `buyer_guest_checkout_id` would give an authenticated buyer's order a
     * guest contact record nobody consented to.
     *
     * `'external'` leaves `buyer_oxy_user_id` unconstrained: connector imports
     * write `ext:<provider>:<externalId>` there today, and their real identity
     * is the `source_*` columns beside it. Naming the shape does not rewrite
     * those rows — ADR 0003 M4/M9 own that retirement.
     *
     * #106 WIDENED this constraint with ADR 0003 D6's two remaining conjuncts,
     * over `claimed_by_oxy_user_id` / `claimed_at`, rather than adding a second
     * one — so there stays exactly one place that says what a buyer identity
     * is. The widening carries three separate facts:
     *
     *  - **Only a guest order may be claimed.** An `oxy` order already has an
     *    owner and a second one would be an unexplained co-owner; an
     *    `'external'` import's buyer is the source platform's and Mercaria
     *    cannot give it away.
     *  - **The claim PAIR travels together** (`num_nonnulls … in (0, 2)`), the
     *    `guest_sessions.converted_*` mechanism: a claimant with no timestamp
     *    is an unauditable ownership change.
     *  - **A claimed order is still a guest order.** `buyer_oxy_user_id` stays
     *    NULL in the guest disjunct whether or not a claim exists, so a claim
     *    can never be written into the ORIGIN column (I1 + I7 at the storage
     *    layer).
     */
    check(
      'orders_buyer_identity_check',
      sql`(${t.buyerOrigin} = 'oxy'
             and ${t.buyerOxyUserId} is not null
             and ${t.buyerGuestCheckoutId} is null
             and ${t.claimedByOxyUserId} is null
             and ${t.claimedAt} is null)
          or (${t.buyerOrigin} = 'guest'
             and ${t.buyerGuestCheckoutId} is not null
             and ${t.buyerOxyUserId} is null
             and num_nonnulls(${t.claimedByOxyUserId}, ${t.claimedAt}) in (0, 2))
          or (${t.buyerOrigin} = 'external'
             and ${t.buyerGuestCheckoutId} is null
             and ${t.claimedByOxyUserId} is null
             and ${t.claimedAt} is null)`,
    ),
    /**
     * The seller side mirrors the listing owner: exactly one of the two is set
     * — except for `platform`, where NEITHER is (#123, ADR 0004 D1).
     *
     * The third disjunct is what makes "no connected-seller transfer exists for
     * a retail order" structural rather than a branch. Transfer creation looks
     * up a `provider_accounts` row by (ownerType, ownerId); a `platform` order
     * has no owner id to look one up WITH, and there is no Mercaria account on
     * its own rail for it to find. So the absence of both columns is the
     * mechanism, and widening this CHECK to let a retail order name a seller
     * would be the single edit that could put Mercaria's own retail share into
     * a Connect transfer.
     */
    check(
      'orders_seller_exclusivity_check',
      sql`(${t.sellerType} = 'user' and ${t.sellerOxyUserId} is not null and ${t.storeId} is null)
          or (${t.sellerType} = 'store' and ${t.storeId} is not null and ${t.sellerOxyUserId} is null)
          or (${t.sellerType} = 'platform' and ${t.sellerOxyUserId} is null and ${t.storeId} is null)`,
    ),
    /**
     * `sellerType = 'platform'` ⇔ `commercialRole = 'mercaria_retail'` — the
     * biconditional ADR 0004 D1 names, as one CHECK rather than two.
     *
     * Both directions matter and they fail differently. A `platform` order
     * marked `connected_marketplace` would enter commission arithmetic with no
     * seller to net against, so its whole gross would fall into the residual
     * and be booked as Mercaria commission on a zero-markup sale — D7 proof 1
     * broken silently, in the direction that reads as revenue. A
     * `mercaria_retail` order naming a store or a P2P seller would credit that
     * seller a payable for goods Mercaria bought from a supplier, and settle it
     * to them.
     */
    check(
      'orders_commercial_role_seller_check',
      sql`(${t.sellerType} = 'platform') = (${t.commercialRole} = 'mercaria_retail')`,
    ),
    // An fx-rate snapshot is complete or absent. `provider` is part of the
    // snapshot's identity — a stored rate nobody can attribute to a source is
    // not reproducible — so it is inside the count, not beside it.
    check(
      'orders_fx_rate_complete_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateProvider}, ${t.fxRateAsOf}) in (0, 5)`,
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
    // "Which orders belong to this guest contact?" — the read #108's portal and
    // #109's claim both walk. Partial, because guest orders are the minority
    // and a full index would be almost entirely NULLs.
    index('orders_buyer_guest_checkout_id_idx')
      .on(t.buyerGuestCheckoutId)
      .where(sql`${t.buyerGuestCheckoutId} is not null`),
    // The CLAIMED half of a buyer's order history (ADR 0003 D7). The buyer list
    // predicate is `buyer_oxy_user_id = $1 OR claimed_by_oxy_user_id = $1`,
    // executed as two indexed scans — this is the second, and
    // `orders_buyer_created_at_idx` above is the first. Partial, because a
    // claim is rare relative to orders and a full index would be almost
    // entirely NULLs; until any claim exists the plan degenerates to exactly
    // today's.
    index('orders_claimed_by_created_at_idx')
      .on(t.claimedByOxyUserId, t.createdAt.desc())
      .where(sql`${t.claimedByOxyUserId} is not null`),
    // "Which orders does this payment fund?" — the reverse of `payment_id`, and
    // the join an operator trace walks. Partial, because most orders have no
    // payment yet and those rows would be the bulk of a full index.
    index('orders_payment_id_idx').on(t.paymentId).where(sql`${t.paymentId} is not null`),
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
 *
 * Frozen by COLUMN, not by row: `order_items_snapshot_immutable` (#375) refuses
 * a rewrite of the twenty columns that say what was sold and at what price, and
 * `order_items_condition_immutable` (#90) governs the three condition columns
 * separately. `position` and the two timestamps stay open — `position` because
 * `db/__tests__/condition.realdb.test.ts` asserts an ordinary UPDATE still
 * succeeds there, which is what proves both triggers are column-scoped rather
 * than whole-row refusals that would pass every other assertion vacuously.
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
    /**
     * The item's condition AS PRESENTED AT CHECKOUT (#90 propagation rule 2,
     * acceptance 3).
     *
     * NULLABLE, permanently, and that is not a gap: every order placed before
     * #90 has no condition, and #90 migration rule 3 says those orders keep
     * their original snapshot and gain only a safe READ projection. Nothing
     * backfills them — `deriveOrderItemCondition` answers `{recorded: false}`,
     * and its discriminated union means a refund or dispute surface cannot read
     * a `key` that was never captured.
     *
     * All three columns REFUSE UPDATE by trigger
     * (`mercaria_order_item_condition_immutable`, hand-written in #90's `pre`
     * migration). An
     * "immutable once set" rule would still admit a backfill writing NULL → a
     * value; refusing every update is what makes "existing placed orders must
     * not be rewritten" true against a future migration as well as against a
     * service bug.
     *
     * `condition_group` is deliberately NOT a column. The KEY is the stored
     * fact; how keys are bucketed for display is a presentation decision that
     * should improve for old orders too, and a stored copy could disagree with
     * the map every other surface reads.
     */
    conditionKey: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }),
    conditionAssertion: text({ enum: asEnumValues(CONDITION_ASSERTIONS) }),
    /** The listing's disclosed condition notes, flattened at purchase. */
    conditionNotes: text(),
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
    checkOneOf('order_items_condition_key_check', t.conditionKey, ITEM_CONDITION_KEYS),
    checkOneOf('order_items_condition_assertion_check', t.conditionAssertion, CONDITION_ASSERTIONS),
    // A snapshot is whole or absent. A key with no assertion could not say
    // whether the buyer was shown a seller's own statement or a migrated
    // default, which is precisely the question a dispute asks.
    check(
      'order_items_condition_snapshot_complete_check',
      sql`(${t.conditionKey} is null) = (${t.conditionAssertion} is null)`,
    ),
    // Notes without a condition would be a description of nothing.
    check(
      'order_items_condition_notes_check',
      sql`${t.conditionNotes} is null or ${t.conditionKey} is not null`,
    ),
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
 *
 * Append-only by `order_item_option_values_append_only` (#375): this is what the
 * receipt says the buyer chose. DELETE stays permitted: the FK cascade from
 * `order_items`.
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
 * `at`. `created_at` is not added either — `at` already is it, and two birth
 * timestamps that can disagree is exactly the redundancy this port removes.
 *
 * ## Append-only is `order_status_history_append_only`, not the missing column
 *
 * The ABSENCE of `updated_at` used to be described as the append-only contract.
 * It is not one: it stops an ORM idiom and nothing else. Measured against a
 * real server before #375, the status, the instant, the acting account and the
 * free-text note were ALL rewritable — so an audit row could be reattributed to
 * a different person, which is the one thing an audit trail exists to prevent.
 * The trigger refuses every UPDATE. DELETE stays permitted, because this table
 * cascades from `orders` and a refusal would break that cascade rather than
 * protect anything.
 *
 * ## The actor is a KIND plus at most one id (ADR 0003 D16, #106)
 *
 * Before #106 the only actor column was `by_oxy_user_id`, so "a guest cancelled
 * this" and "the expiry sweep cancelled this" were the same row: both NULL. The
 * trail could not answer who acted, which is the one question an audit trail
 * exists for. `actor_kind` answers it, and the two id columns are then
 * mutually exclusive BY KIND rather than by convention:
 *
 *  - `oxy` / `operator` → `by_oxy_user_id`, `actor_guest_session_id` NULL;
 *  - `guest` → `actor_guest_session_id`, `by_oxy_user_id` NULL;
 *  - `system` → neither.
 *
 * `order_status_history_actor_check` states it, which is how invariant I1
 * ("a guest id is never accepted where an Oxy id is expected") reaches audit
 * rows: a service bug that put a session id in the Oxy column is refused by the
 * database rather than discovered in a support conversation.
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
    /**
     * WHICH KIND of actor drove this transition.
     *
     * `default('system')` for the same reason `orders.buyer_origin` defaults:
     * Postgres fills an existing table with a fast default and no rewrite. The
     * backfill then corrects the rows that actually had an Oxy actor
     * (`by_oxy_user_id IS NOT NULL` ⇒ `'oxy'`), so the default is the honest
     * value for exactly the rows it survives on. Every writer states it
     * EXPLICITLY; a new writer leaning on the default would silently attribute
     * a person's action to the system.
     */
    actorKind: text({ enum: asEnumValues(ORDER_ACTOR_KINDS) }).notNull().default('system'),
    /** An Oxy account id — no foreign key. Set iff `actor_kind` is oxy/operator. */
    byOxyUserId: text(),
    /**
     * The `guest_sessions` ROW ID when a guest acted — never the token.
     *
     * Correlation with no foreign key, and the reason is the same one
     * `guest_checkouts.guest_session_id` carries: the session is HARD-DELETED
     * by the retention sweep 7 days after it expires while this trail is
     * retained with its order, so a cascade would erase an audit record and a
     * restrict would block the purge. The trail outlives the credential without
     * extending its life (ADR 0003 D11/D16).
     *
     * Registered in `db/protectedColumns.ts`: it is a guest identifier on a
     * table every order DTO reads whole, and #106 buyer-model rule 7 says
     * seller-facing hydration must not expose one. Withholding it structurally
     * is stronger than remembering to omit it in a serializer.
     */
    actorGuestSessionId: text(),
    note: text(),
  },
  (t) => [
    checkOneOf('order_status_history_status_check', t.status, ORDER_STATUSES),
    checkOneOf('order_status_history_actor_kind_check', t.actorKind, ORDER_ACTOR_KINDS),
    // The kind decides which id column may be written, and NEITHER may hold the
    // other's value. Written as one CHECK over three columns rather than two
    // independent ones, because the illegal combinations are the dangerous
    // ones: a guest session id in `by_oxy_user_id` is I1 broken in an audit row,
    // and an actor kind with no id where the kind requires one is a trail that
    // names nobody while claiming to name somebody.
    check(
      'order_status_history_actor_check',
      sql`(${t.actorKind} in ('oxy', 'operator')
             and ${t.byOxyUserId} is not null
             and ${t.actorGuestSessionId} is null)
          or (${t.actorKind} = 'guest'
             and ${t.byOxyUserId} is null
             and ${t.actorGuestSessionId} is not null)
          or (${t.actorKind} = 'system'
             and ${t.byOxyUserId} is null
             and ${t.actorGuestSessionId} is null)`,
    ),
    index('order_status_history_order_id_at_idx').on(t.orderId, t.at),
  ],
);

/**
 * `order_applied_discounts` — one discount's contribution, persisted so a refund
 * can be computed against exactly what was charged.
 *
 * Append-only by `order_applied_discounts_append_only` (#375) — that sentence is
 * only true if the allocation cannot move after the charge, and until #375 it
 * could. DELETE stays permitted: the FK cascade from `orders`.
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
     * The discount's `valueType`, or NULL when the SOURCE never stated one.
     *
     * The CHECK stays exactly as tight as `discounts_value_type_check` — the
     * tuple is not widened, because a Mercaria discount must still be one of the
     * four. What changed (#378) is that a second producer arrived: a connector
     * import, which reads somebody else's order. A platform that reports the
     * money a coupon removed without reporting whether the coupon was a
     * percentage or a fixed amount leaves this genuinely unknown, and NULL is
     * how this schema says unknown — a default would be a false snapshot of
     * another shop's discount, and `in (...)` over NULL is NULL, which a CHECK
     * accepts, so the constraint still refuses every value outside the tuple.
     */
    valueType: text({ enum: asEnumValues(DISCOUNT_VALUE_TYPES) }),
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

/**
 * `order_tax_lines` — one applied rate's contribution, a SINGLE-currency shop
 * amount.
 *
 * Append-only by `order_tax_lines_append_only` (#375): a tax authority can ask
 * about this figure years later. DELETE stays permitted: the FK cascade from
 * `orders`.
 */
export const orderTaxLines = pgTable(
  'order_tax_lines',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * Basis points — 800 = 8% — or NULL when the SOURCE never stated a rate.
     *
     * `order_applied_discounts.value_type`'s reasoning applied to tax (#378): a
     * platform can report what a rate collected without reporting the rate, and
     * a line claiming zero basis points beside a non-zero amount is a worse
     * record than one that says the rate is unknown. Mercaria's own pricing
     * engine always writes it, because it read the `TaxRate` row.
     */
    rateBps: integer(),
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
 *
 * ## The provider columns are the money, and they lag the record deliberately
 *
 * Everything above `provider` is the COMMERCE record: what was approved, what
 * came back on the shelf, what the order is now worth. It commits first, and
 * ADR 0001 D7 is why — the refund domain owns *what* is refundable and the rail
 * only records the movement, so a rail being slow or unreachable must not be
 * able to refuse a refund a merchant has authorised.
 *
 * The eight columns below are that movement, and they are nullable together
 * with it: a `manual_pos` refund is cash out of a drawer and an `external` one
 * happened on Shopify, so for both there is no provider operation to record and
 * `provider IS NULL` is the honest row rather than a gap (#49 scope 9).
 *
 * ## The reversal is tracked apart from the refund, because it can fail alone
 *
 * A refund on a settled order is TWO movements — money to the buyer, and the
 * seller's proportional share of that order's transfer reversed to recover it —
 * and the second can fail where the first did not. ADR 0001 D7 says the buyer's
 * refund is not blocked on it, so the two states are separate columns and a
 * failed recovery leaves the order's `merchant_payable` open in Mercaria's
 * favour, which is exactly what "the seller still owes this" means in accounts.
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
    /**
     * The rail the money goes back through, and the payment it draws from.
     *
     * NULL for a refund with no provider operation — see the table docblock.
     * `payment_id` is CORRELATION with no foreign key, the same rule every other
     * payment↔commerce link in this schema follows: a financial record must stay
     * readable independently of its commerce partner.
     */
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }),
    paymentId: text(),
    /**
     * The rail's own id for this refund (`re_…`), and NEVER a Mercaria key —
     * the same invariant every `provider_object_id` in `./payments` carries.
     *
     * Sparse-unique per provider, because it is the key an inbound
     * `charge.refund.updated` correlates through, and two rows claiming one
     * provider refund would make that correlation ambiguous at exactly the
     * moment it decides whether a refund succeeded.
     */
    providerRefundId: text(),
    providerState: text({ enum: asEnumValues(REFUND_PROVIDER_STATES) }),
    /** The rail's machine-readable failure code, filtered to a safe subset. */
    providerFailureCode: text(),
    reversalState: text({ enum: asEnumValues(REFUND_REVERSAL_STATES) }),
    /** The rail's own id for the reversal (`trr_…`). */
    providerReversalId: text(),
    /**
     * What the reversal recovered from the seller, in the PLATFORM settlement
     * currency — which is the transfer's currency, not the refund's.
     *
     * Both columns present or absent together (`refunds_reversal_complete_check`).
     * It is a `Money` rather than a `DualMoney` for the same reason
     * `transfers.amount` is: a reversal has exactly one currency, the one the
     * money is denominated in on the platform balance.
     */
    ...optionalMoney('reversalAmount'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('refunds_type_check', t.type, REFUND_TYPES),
    checkOneOf('refunds_status_check', t.status, REFUND_STATUSES),
    checkOneOf('refunds_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('refunds_provider_state_check', t.providerState, REFUND_PROVIDER_STATES),
    checkOneOf('refunds_reversal_state_check', t.reversalState, REFUND_REVERSAL_STATES),
    ...currencyChecks('refunds', [
      t.refundShippingShopCurrency,
      t.refundShippingPresentmentCurrency,
      t.totalRefundedShopCurrency,
      t.totalRefundedPresentmentCurrency,
      t.reversalAmountCurrency,
    ]),
    check(
      'refunds_refund_shipping_complete_check',
      sql`num_nonnulls(${t.refundShippingShopAmount}, ${t.refundShippingShopCurrency}, ${t.refundShippingPresentmentAmount}, ${t.refundShippingPresentmentCurrency}) in (0, 4)`,
    ),
    // A provider operation is a rail AND a state, or it is neither. A state with
    // no rail is a refund nobody can ask about, and a rail with no state is a
    // row that never records whether the money left.
    check(
      'refunds_provider_operation_complete_check',
      sql`num_nonnulls(${t.provider}, ${t.providerState}) in (0, 2)`,
    ),
    check(
      'refunds_reversal_complete_check',
      sql`num_nonnulls(${t.reversalAmountAmount}, ${t.reversalAmountCurrency}) in (0, 2)`,
    ),
    check(
      'refunds_reversal_amount_check',
      sql`${t.reversalAmountAmount} is null or ${t.reversalAmountAmount} >= 0`,
    ),
    index('refunds_order_id_created_at_idx').on(t.orderId, t.createdAt.desc()),
    index('refunds_store_id_status_created_at_idx').on(t.storeId, t.status, t.createdAt.desc()),
    uniqueIndex('refunds_rma_number_key').on(t.rmaNumber).where(sql`${t.rmaNumber} is not null`),
    uniqueIndex('refunds_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // "Which Mercaria refund is this provider refund?" — the correlation every
    // inbound refund event starts from, and the constraint that stops two rows
    // claiming one movement.
    uniqueIndex('refunds_provider_refund_id_key')
      .on(t.provider, t.providerRefundId)
      .where(sql`${t.providerRefundId} is not null`),
    // The operator queue: refunds whose money has not landed, oldest first.
    index('refunds_provider_state_created_at_idx')
      .on(t.providerState, t.createdAt)
      .where(sql`${t.providerState} is not null`),
    index('refunds_payment_id_created_at_idx')
      .on(t.paymentId, t.createdAt.desc())
      .where(sql`${t.paymentId} is not null`),
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
