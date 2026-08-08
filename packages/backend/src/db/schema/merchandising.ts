/**
 * Merchandising: `collections`, `collection_rules`, `listing_collections`,
 * `discounts`, `discount_codes`.
 *
 * Two Mongo mechanisms are replaced here rather than copied, and both replace a
 * denormalization with a relation.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import type {
  CollectionRuleField,
  CollectionRuleOperator,
  CollectionSortOrder,
  CollectionType,
  DiscountMethod,
  DiscountScope,
  DiscountValueType,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { listings } from './catalog';
import { stores } from './stores';

/** `Collection.type` — `COLLECTION_TYPES` in `models/collection.ts`. */
export const COLLECTION_TYPES: readonly CollectionType[] = ['manual', 'automated'];

/** `Collection.sortOrder` — `COLLECTION_SORT_ORDERS`. */
export const COLLECTION_SORT_ORDERS: readonly CollectionSortOrder[] = [
  'manual',
  'best_selling',
  'price_asc',
  'price_desc',
  'created_desc',
  'title_asc',
];

/** `CollectionRule.field` — `COLLECTION_RULE_FIELDS`. */
export const COLLECTION_RULE_FIELDS: readonly CollectionRuleField[] = [
  'title',
  'productType',
  'vendor',
  'tag',
  'price',
  'categorySlug',
  'compareAtPrice',
  'inventory',
];

/** `CollectionRule.operator` — `COLLECTION_RULE_OPERATORS`. */
export const COLLECTION_RULE_OPERATORS: readonly CollectionRuleOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'gt',
  'lt',
  'gte',
  'lte',
];

/** `Discount.method` — `DISCOUNT_METHODS` in `models/discount.ts`. */
export const DISCOUNT_METHODS: readonly DiscountMethod[] = ['code', 'automatic'];

/** `Discount.valueType` — `DISCOUNT_VALUE_TYPES`. */
export const DISCOUNT_VALUE_TYPES: readonly DiscountValueType[] = [
  'percentage',
  'fixed_amount',
  'bogo',
  'free_item',
];

/** `Discount.appliesTo.scope` — `DISCOUNT_SCOPES`. */
export const DISCOUNT_SCOPES: readonly DiscountScope[] = ['order', 'products', 'collections'];

/** A BOGO leg's scope — never the whole order. `DISCOUNT_LEG_SCOPES`. */
export const DISCOUNT_LEG_SCOPES: readonly Exclude<DiscountScope, 'order'>[] = [
  'products',
  'collections',
];

/** `Discount.minimumRequirement.type` — `MINIMUM_REQUIREMENT_TYPES`. */
export const MINIMUM_REQUIREMENT_TYPES = ['none', 'subtotal', 'quantity'] as const;

/** `Discount.customerEligibility.type` — `CUSTOMER_ELIGIBILITY_TYPES`. */
export const CUSTOMER_ELIGIBILITY_TYPES = ['all', 'groups', 'customers'] as const;

/**
 * `collections` — a merchandising grouping of a store's products.
 *
 * `productIds` is NOT a column here: it moves into `listing_collections` along
 * with the materialized membership it produces. See that table for why the two
 * become one.
 */
export const collections = pgTable(
  'collections',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    handle: text().notNull(),
    description: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    imageFileId: text(),
    type: text({ enum: asEnumValues(COLLECTION_TYPES) }).notNull(),
    /** `rules.appliesDisjunctively` — the conditions themselves are a child table. */
    rulesAppliesDisjunctively: boolean().notNull().default(false),
    sortOrder: text({ enum: asEnumValues(COLLECTION_SORT_ORDERS) }).notNull().default('manual'),
    seoTitle: text(),
    seoDescription: text(),
    isPublished: boolean().notNull().default(true),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('collections_type_check', t.type, COLLECTION_TYPES),
    checkOneOf('collections_sort_order_check', t.sortOrder, COLLECTION_SORT_ORDERS),
    uniqueIndex('collections_store_id_handle_key').on(t.storeId, t.handle),
    index('collections_store_id_is_published_idx').on(t.storeId, t.isPublished),
  ],
);

/**
 * `collection_rules` — one condition of an automated collection's rule set.
 *
 * `{field, operator, value}` entities in an ordered list, so a child table
 * rather than `jsonb`: the shape is fully known, and the rule evaluator reads
 * them one by one.
 */
export const collectionRules = pgTable(
  'collection_rules',
  {
    id: generatedId(),
    collectionId: text()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    field: text({ enum: asEnumValues(COLLECTION_RULE_FIELDS) }).notNull(),
    operator: text({ enum: asEnumValues(COLLECTION_RULE_OPERATORS) }).notNull(),
    value: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('collection_rules_field_check', t.field, COLLECTION_RULE_FIELDS),
    checkOneOf('collection_rules_operator_check', t.operator, COLLECTION_RULE_OPERATORS),
    index('collection_rules_collection_id_position_idx').on(t.collectionId, t.position),
  ],
);

/**
 * `listing_collections` — which listings are in which collection.
 *
 * ## This ONE table replaces TWO Mongo fields, and that is the decision to read
 *
 * Mongo carried the membership twice: `Collection.productIds` (the hand-picked,
 * ORDERED input of a MANUAL collection) and `Listing.collectionIds` (the
 * MATERIALIZED membership of both kinds, written by
 * `collection.service.materialize`). For a manual collection those two sets are
 * the same set — `materialize` computes `shouldHave` as literally
 * `[...collection.productIds]` — so keeping both would be storing one fact in
 * two places that can disagree, which is the shape this port exists to remove.
 *
 * `position` carries the only information the two did not share: the manual
 * ordering that `sortOrder: 'manual'` pages by. NULL means the membership was
 * DERIVED from rules and has no hand-picked order.
 *
 * ## What the foreign keys fix
 *
 * `deleteCollection` deletes the collection and then, in a second statement,
 * `$pull`s its id from every listing that carried it, "so no
 * `Listing.collectionIds` dangles". `ON DELETE CASCADE` is that second statement
 * as a constraint — atomic, and it cannot half-happen if the process dies
 * between the two writes.
 *
 * The FK to `listings` has no counterpart in Mongo at all, and closes a real
 * hole: `productIds` could name a listing that no longer exists, and did so
 * silently (`materialize` just matched nothing for it). NOTE for the Fase 4
 * backfill: a `productIds` entry pointing at a missing listing must be DROPPED
 * rather than inserted, or the migration fails on a foreign-key violation.
 */
export const listingCollections = pgTable(
  'listing_collections',
  {
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    collectionId: text()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** Hand-picked order for a MANUAL collection; NULL when derived from rules. */
    position: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    // The membership IS the key — no surrogate id. A listing is in a collection
    // once or not at all, which `$addToSet` approximated and this states.
    primaryKey({ name: 'listing_collections_pkey', columns: [t.listingId, t.collectionId] }),
    // Collection browse: every listing in a collection, in manual order.
    index('listing_collections_collection_id_position_idx').on(t.collectionId, t.position),
    // The reverse — every collection a listing belongs to, for the cart/checkout
    // discount-eligibility snapshot.
    index('listing_collections_listing_id_idx').on(t.listingId),
  ],
);

/**
 * `discounts` — a store-scoped promotion.
 *
 * `value` is a `bigint`, not an `integer`, and the reason is the same one that
 * governs every money amount here: for `valueType: 'fixed_amount'` this IS a
 * money amount in minor units, so a 25 ⊜ discount is 2_500_000_000 — past the
 * `integer` ceiling. For `percentage` it is basis points and small; one column
 * has to hold both, so it holds the larger.
 *
 * The `appliesTo`, `buy`, `get`, `minimumRequirement`, `customerEligibility`,
 * `usageLimits` and `combinesWith` sub-documents are all fixed small shapes and
 * flatten into columns. Their id ARRAYS (`productIds`, `collectionIds`,
 * `customerIds`) stay `text[]`: the pricing engine loads the discount whole and
 * tests membership in memory (`pricing.service` line-eligibility), so nothing
 * queries them by element in SQL and a junction table would be four more tables
 * serving no query.
 */
export const discounts = pgTable(
  'discounts',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    method: text({ enum: asEnumValues(DISCOUNT_METHODS) }).notNull(),
    valueType: text({ enum: asEnumValues(DISCOUNT_VALUE_TYPES) }).notNull(),
    /** Basis points, or minor units for `fixed_amount` — see the table docblock. */
    value: bigint({ mode: 'number' }).notNull(),

    // `appliesTo` — what the discount targets.
    appliesToScope: text({ enum: asEnumValues(DISCOUNT_SCOPES) }).notNull(),
    appliesToProductIds: text().array(),
    appliesToCollectionIds: text().array(),

    // `buy` / `get` — the BOGO legs. Absent on non-BOGO discounts.
    buyQuantity: integer(),
    buyScope: text({ enum: asEnumValues(DISCOUNT_LEG_SCOPES) }),
    buyProductIds: text().array(),
    buyCollectionIds: text().array(),
    /**
     * BASIS POINTS despite the name — `pricing.service` reads it as
     * `get.discountPercent ?? 10000` bps, so 10000 is 100%. An integer, and the
     * name is the source model's; it is not renamed here because the DTO and
     * every request body still spell it this way.
     */
    buyDiscountPercent: integer(),
    getQuantity: integer(),
    getScope: text({ enum: asEnumValues(DISCOUNT_LEG_SCOPES) }),
    getProductIds: text().array(),
    getCollectionIds: text().array(),
    /** Basis points — see `buyDiscountPercent`. */
    getDiscountPercent: integer(),

    // `minimumRequirement` — a cart threshold. `value` is a subtotal in minor
    // units OR a quantity, so it takes the larger type for the same reason
    // `value` above does.
    minimumRequirementType: text({ enum: asEnumValues(MINIMUM_REQUIREMENT_TYPES) }),
    minimumRequirementValue: bigint({ mode: 'number' }),

    // `customerEligibility` — who may use it.
    customerEligibilityType: text({ enum: asEnumValues(CUSTOMER_ELIGIBILITY_TYPES) }),
    customerEligibilityCustomerIds: text().array(),
    customerEligibilityGroupTags: text().array(),

    // `usageLimits` — caps. Absent means uncapped, which is not zero.
    usageLimitsTotalMax: integer(),
    usageLimitsPerCustomerMax: integer(),

    // `combinesWith` — which other discount classes this may stack with.
    combinesWithOrderDiscounts: boolean().notNull().default(false),
    combinesWithProductDiscounts: boolean().notNull().default(false),
    combinesWithShippingDiscounts: boolean().notNull().default(false),

    startsAt: timestamptz().notNull(),
    endsAt: timestamptz(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('discounts_method_check', t.method, DISCOUNT_METHODS),
    checkOneOf('discounts_value_type_check', t.valueType, DISCOUNT_VALUE_TYPES),
    checkOneOf('discounts_applies_to_scope_check', t.appliesToScope, DISCOUNT_SCOPES),
    checkOneOf('discounts_buy_scope_check', t.buyScope, DISCOUNT_LEG_SCOPES),
    checkOneOf('discounts_get_scope_check', t.getScope, DISCOUNT_LEG_SCOPES),
    checkOneOf(
      'discounts_minimum_requirement_type_check',
      t.minimumRequirementType,
      MINIMUM_REQUIREMENT_TYPES,
    ),
    checkOneOf(
      'discounts_customer_eligibility_type_check',
      t.customerEligibilityType,
      CUSTOMER_ELIGIBILITY_TYPES,
    ),
    // A scheduled window that ends before it starts never applies, and is far
    // more likely a swapped pair of inputs than an intent.
    check('discounts_window_check', sql`${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
    // The target of `discount_codes`'s COMPOSITE foreign key. `id` is already
    // unique on its own; this pair exists so a code row cannot claim a different
    // store than its discount belongs to.
    unique('discounts_id_store_id_key').on(t.id, t.storeId),
    index('discounts_store_id_is_active_method_idx').on(t.storeId, t.isActive, t.method),
    // The scheduled-window scan: `startsAt <= now <= endsAt` per store + method.
    index('discounts_store_id_method_window_idx').on(t.storeId, t.method, t.startsAt, t.endsAt),
  ],
);

/**
 * `discount_codes` — one redeemable code and its redemption counter.
 *
 * ## `store_id` is denormalized ON PURPOSE, and the unique index is why
 *
 * Mongo enforced per-store code uniqueness with `{storeId, 'codes.code'}` — a
 * compound index reaching from the parent document into the embedded array.
 * Postgres cannot put a UNIQUE across a join, so the store must be ON this row
 * for `unique(store_id, code)` to be expressible at all. The alternative is a
 * uniqueness rule enforced only in the service layer, which is precisely what
 * fails when two requests race.
 *
 * The redundancy is constrained rather than trusted: `unique(id, store_id)` on
 * the parent plus a COMPOSITE foreign key means a code row cannot name a
 * different store than its discount does.
 *
 * ## `usage_count` replaces an `arrayFilters` + `$expr` update
 *
 * Incrementing one code's counter inside an embedded array needed positional
 * filters and a guarded `$expr`. Here it is `update ... set usage_count =
 * usage_count + 1 where id = ?`, which is atomic on its own.
 */
export const discountCodes = pgTable(
  'discount_codes',
  {
    id: generatedId(),
    /** Constrained together with `storeId` by the composite key below. */
    discountId: text().notNull(),
    /** Denormalized from the parent so per-store uniqueness is expressible. */
    storeId: text().notNull(),
    code: text().notNull(),
    usageCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ONE composite foreign key rather than two independent ones: it constrains
    // the PAIR, so `store_id` is forced to agree with the parent discount's own
    // store instead of merely being a valid store somewhere.
    foreignKey({
      name: 'discount_codes_discount_id_store_id_fkey',
      columns: [t.discountId, t.storeId],
      foreignColumns: [discounts.id, discounts.storeId],
    }).onDelete('cascade'),
    check('discount_codes_usage_count_check', sql`${t.usageCount} >= 0`),
    uniqueIndex('discount_codes_store_id_code_key').on(t.storeId, t.code),
    index('discount_codes_discount_id_idx').on(t.discountId),
  ],
);
