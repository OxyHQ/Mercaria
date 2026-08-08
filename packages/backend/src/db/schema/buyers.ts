/**
 * The buyer's own side of the marketplace: `carts`, `cart_items`, `addresses`,
 * `favorites`, `reviews`, `seller_profiles`, `user_preferences`, `feedback`.
 *
 * Every one of these is keyed by an Oxy account id and none of them can carry a
 * foreign key for it — Oxy owns identity and Mercaria reaches it over HTTP.
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
import { ALL_CURRENCY_CODES, type ReviewTargetType } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks } from './columns';
import { listings, productVariants } from './catalog';
import { orders } from './orders';
import { stores } from './stores';

/** `Review.targetType` — `TARGET_TYPES` in `models/review.ts`. */
export const REVIEW_TARGET_TYPES: readonly ReviewTargetType[] = ['listing', 'store', 'seller'];

/** `Review.status` — `REVIEW_STATUSES` in `models/review.ts`. */
export const REVIEW_STATUSES = ['published', 'hidden'] as const;

/** `Feedback.type` — the enum in `models/feedback.ts`. */
export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;

/** `Feedback.status` — the enum in `models/feedback.ts`. */
export const FEEDBACK_STATUSES = ['pending', 'reviewed', 'resolved'] as const;

/** Lowest and highest allowed star rating — `MIN_RATING`/`MAX_RATING` in `models/review.ts`. */
const MIN_REVIEW_RATING = 1;
const MAX_REVIEW_RATING = 5;

/** `carts` — a buyer's basket, exactly one per Oxy user. */
export const carts = pgTable(
  'carts',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** Codes pinned to the cart, normalized uppercase, applied at checkout. */
    pendingDiscountCodes: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('carts_oxy_user_id_key').on(t.oxyUserId)],
);

/**
 * `cart_items` — a variant and a quantity, never a price.
 *
 * Prices and availability are read LIVE from the variant at view and checkout
 * time, so the cart can never serve a stale price.
 *
 * ## Both catalogue foreign keys CASCADE, and that is a behaviour change
 *
 * `catalog-write.removeVariant` deletes variants. Today a cart holding one is
 * left with a line pointing at nothing, which surfaces as a failure at checkout
 * — far from the cause, to a buyer who did nothing wrong. Cascading removes the
 * line when the variant goes, which is what the checkout code has to cope with
 * anyway and states it at the schema instead of at the till.
 */
export const cartItems = pgTable(
  'cart_items',
  {
    id: generatedId(),
    cartId: text()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    addedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongoose's `min: 1` on the embedded quantity.
    check('cart_items_quantity_check', sql`${t.quantity} > 0`),
    // One line per variant per cart — adding the same variant twice bumps the
    // quantity rather than creating a second line, which the service does today
    // and nothing enforced.
    uniqueIndex('cart_items_cart_id_variant_id_key').on(t.cartId, t.variantId),
    index('cart_items_variant_id_idx').on(t.variantId),
  ],
);

/**
 * `addresses` — a buyer's saved shipping address.
 *
 * The nine fields are written out rather than taken from `addressColumns`: this
 * is the address ENTITY, not a snapshot embedded under a prefix, so its columns
 * are unprefixed (`line1`, not `shipping_address_line1`).
 */
export const addresses = pgTable(
  'addresses',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    label: text(),
    recipientName: text().notNull(),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    region: text(),
    postalCode: text().notNull(),
    country: text().notNull(),
    phone: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Resolves "the user's default, else newest" in one indexed read.
    index('addresses_oxy_user_id_default_created_at_idx').on(
      t.oxyUserId,
      t.isDefault.desc(),
      t.createdAt.desc(),
    ),
    // `address.service` promotes a new default by clearing the old one. Mongo
    // could not state the invariant that makes that correct; here at most one
    // address per user is default, so a half-finished promotion cannot persist.
    uniqueIndex('addresses_oxy_user_id_default_key')
      .on(t.oxyUserId)
      .where(sql`${t.isDefault}`),
  ],
);

/** `favorites` — a buyer's saved listing; the unique pair makes the toggle idempotent. */
export const favorites = pgTable(
  'favorites',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('favorites_oxy_user_id_listing_id_key').on(t.oxyUserId, t.listingId),
    index('favorites_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('favorites_listing_id_idx').on(t.listingId),
  ],
);

/**
 * `reviews` — a verified buyer's review of ONE target.
 *
 * A review targets a listing, a store or a P2P seller, and exactly the matching
 * target column is set — an invariant the Mongoose model stated only in prose
 * and enforced nowhere. It is a CHECK here.
 *
 * `order_id` is `restrict`: it is the link that makes the review VERIFIED, and
 * erasing the order would leave a review claiming a purchase with nothing behind
 * it. Nothing deletes an order, so it never fires.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    authorOxyUserId: text().notNull(),
    targetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }).notNull(),
    listingId: text().references(() => listings.id, { onDelete: 'cascade' }),
    storeId: text().references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. Set iff `targetType = 'seller'`. */
    sellerOxyUserId: text(),
    orderId: text().references(() => orders.id, { onDelete: 'restrict' }),
    rating: integer().notNull(),
    title: text(),
    body: text(),
    status: text({ enum: asEnumValues(REVIEW_STATUSES) }).notNull().default('published'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('reviews_target_type_check', t.targetType, REVIEW_TARGET_TYPES),
    // `hidden` is written by moderation enforcement via `updateOne`, which runs
    // no Mongoose validator — so a CHECK missing it would disarm review takedowns
    // exactly as one missing `restricted` would disarm listing takedowns.
    checkOneOf('reviews_status_check', t.status, REVIEW_STATUSES),
    check(
      'reviews_rating_check',
      sql`${t.rating} between ${sql.raw(String(MIN_REVIEW_RATING))} and ${sql.raw(String(MAX_REVIEW_RATING))}`,
    ),
    // Exactly the target matching `targetType` is set, and the other two are not.
    check(
      'reviews_target_exclusivity_check',
      sql`(${t.targetType} = 'listing' and ${t.listingId} is not null and ${t.storeId} is null and ${t.sellerOxyUserId} is null)
          or (${t.targetType} = 'store' and ${t.storeId} is not null and ${t.listingId} is null and ${t.sellerOxyUserId} is null)
          or (${t.targetType} = 'seller' and ${t.sellerOxyUserId} is not null and ${t.listingId} is null and ${t.storeId} is null)`,
    ),
    index('reviews_listing_id_status_created_at_idx').on(
      t.listingId,
      t.status,
      t.createdAt.desc(),
    ),
    index('reviews_store_id_status_created_at_idx').on(t.storeId, t.status, t.createdAt.desc()),
    index('reviews_seller_oxy_user_id_status_created_at_idx').on(
      t.sellerOxyUserId,
      t.status,
      t.createdAt.desc(),
    ),
    // One review per buyer per listing. Store and seller uniqueness is still
    // service-enforced, exactly as it is today — porting it to a constraint is a
    // behaviour change that needs a duplicate audit first, not a schema decision.
    uniqueIndex('reviews_author_oxy_user_id_listing_id_key')
      .on(t.authorOxyUserId, t.listingId)
      .where(sql`${t.listingId} is not null`),
  ],
);

/**
 * `seller_profiles` — the marketplace aggregates Mercaria owns for a P2P seller.
 *
 * Display name, username and avatar are NEVER stored here: they are read live
 * from the Oxy profile at hydration time. That is why a reported `seller` has no
 * CrowdSource subject provider — there is no user-authored identity here to pin
 * into a case snapshot.
 */
export const sellerProfiles = pgTable(
  'seller_profiles',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. The profile's whole identity. */
    oxyUserId: text().notNull(),
    isVerified: boolean().notNull().default(false),
    /** Average review score, 0 when unrated — a computed mean, hence a float. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    salesCount: integer().notNull().default(0),
    shippingPrefsNote: text(),
    shippingPrefsHandlingDays: integer(),
    returnPrefsAccepts: boolean(),
    returnPrefsWindowDays: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('seller_profiles_oxy_user_id_key').on(t.oxyUserId)],
);

/**
 * `user_preferences` — a buyer's currency DISPLAY preferences.
 *
 * Presentation only: these never affect the amounts Mercaria stores. NULL means
 * the consumer has not chosen one and the client falls back to FAIR or a locale
 * default — so both columns are nullable and neither has a default beyond NULL.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    preferredCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    secondaryCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    dualDisplayEnabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('user_preferences', [t.preferredCurrency, t.secondaryCurrency]),
    uniqueIndex('user_preferences_oxy_user_id_key').on(t.oxyUserId),
  ],
);

/**
 * `feedback` — a user's bug report, feature request or note about the product.
 *
 * The one table here whose name is SINGULAR. `CONVENTIONS.md` says plural, and
 * "feedback" is a mass noun with no plural in English — `feedbacks` is not a
 * word, and Mongoose's derived collection name being exactly that is an artifact
 * of `pluralize()`, not a naming decision to inherit. Recorded as the single
 * documented exception rather than left to look like an oversight.
 *
 * `email` is a PROTECTED column: an optional contact address a reporter typed
 * in, on a table an admin surface reads whole.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    type: text({ enum: asEnumValues(FEEDBACK_TYPES) }).notNull(),
    rating: integer(),
    message: text().notNull(),
    email: text(),
    // `metadata` — three columns, not jsonb. The TypeScript interface carries an
    // index signature, but the Mongoose SCHEMA declares only these three paths and
    // strict mode drops everything else, so no open-shaped data was ever stored.
    metadataPlatform: text(),
    metadataAppVersion: text(),
    metadataDeviceInfo: text(),
    status: text({ enum: asEnumValues(FEEDBACK_STATUSES) }).notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('feedback_type_check', t.type, FEEDBACK_TYPES),
    checkOneOf('feedback_status_check', t.status, FEEDBACK_STATUSES),
    check(
      'feedback_rating_check',
      sql`${t.rating} is null or ${t.rating} between ${sql.raw(String(MIN_REVIEW_RATING))} and ${sql.raw(String(MAX_REVIEW_RATING))}`,
    ),
    index('feedback_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('feedback_status_idx').on(t.status),
    index('feedback_type_idx').on(t.type),
  ],
);
