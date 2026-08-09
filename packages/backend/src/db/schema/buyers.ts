/**
 * The buyer's own side of the marketplace: `carts`, `cart_items`, `addresses`,
 * `favorites`, `seller_profiles`, `user_preferences`, `feedback`.
 *
 * Every one of these is keyed by an Oxy account id and none of them can carry a
 * foreign key for it — Oxy owns identity and Mercaria reaches it over HTTP.
 *
 * `reviews` was here until #76 and lives in `schema/reviews.ts` now; see the
 * note where it stood.
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
  ALL_CURRENCY_CODES,
  CART_LINE_REVIEW_REASONS,
  LISTING_SAVE_INTENTS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks } from './columns';
import { listings, productVariants } from './catalog';
import { guestSessions } from './guests';

/** `Feedback.type`. */
export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;

/** `Feedback.status`. */
export const FEEDBACK_STATUSES = ['pending', 'reviewed', 'resolved'] as const;

/** Lowest and highest allowed star rating. */
const MIN_REVIEW_RATING = 1;
const MAX_REVIEW_RATING = 5;

/**
 * `carts` — a buyer's basket, exactly one per OWNER (#104, ADR 0003 D8).
 *
 * ## Two owner columns, not one polymorphic pair
 *
 * `orders` already carries this exact shape on its seller side
 * (`orders_seller_exclusivity_check`), and the reason to repeat it here is
 * structural rather than stylistic: **the two owner id spaces need different
 * referential treatment and one column cannot carry half a foreign key.** An
 * Oxy account id must NOT have one (Oxy owns identity; every such column in
 * this schema says so), while `guest_session_id` MUST: `ON DELETE CASCADE` is
 * what makes retention correct BY CONSTRUCTION — the expiry sweep hard-deletes
 * an expired `guest_sessions` row and the cart and, through the existing
 * `cart_items` cascade, its lines go with it, with no sweep code to keep
 * honest. `provider_accounts` chose a single polymorphic pair because its
 * owner feeds a derived Stripe idempotency key; no such derivation exists here.
 *
 * Exactly-one-owner is the CHECK; one-cart-per-owner is the two PARTIAL
 * uniques. `carts_oxy_user_id_key` keeps its name and its meaning through the
 * migration — it only narrows to `WHERE oxy_user_id IS NOT NULL`, which every
 * existing row already satisfies, so no legacy cart is rewritten and no legacy
 * read changes plan. Postgres treats NULLs as distinct, so the partial
 * predicate is about index SIZE and stated intent rather than correctness —
 * and it is the honest statement of what the index now covers.
 *
 * A guest id is NEVER written into `oxy_user_id` (ADR 0003 I1): the CHECK plus
 * the `CommerceActor`/`CartOwner` unions with no common `id` field are what
 * make that unrepresentable rather than merely discouraged.
 */
export const carts = pgTable(
  'carts',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. NULL exactly when a guest owns this cart. */
    oxyUserId: text(),
    /**
     * The owning `guest_sessions` row id — a real foreign key, because both
     * tables are Mercaria's. CASCADE is the retention mechanism (ADR 0003 D11).
     */
    guestSessionId: text().references(() => guestSessions.id, { onDelete: 'cascade' }),
    /** Codes pinned to the cart, normalized uppercase, applied at checkout. */
    pendingDiscountCodes: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'carts_owner_exclusivity_check',
      sql`num_nonnulls(${t.oxyUserId}, ${t.guestSessionId}) = 1`,
    ),
    uniqueIndex('carts_oxy_user_id_key')
      .on(t.oxyUserId)
      .where(sql`${t.oxyUserId} is not null`),
    uniqueIndex('carts_guest_session_id_key')
      .on(t.guestSessionId)
      .where(sql`${t.guestSessionId} is not null`),
  ],
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
    /**
     * Why a guest→Oxy merge (#104) could not carry this line across exactly as
     * the guest had it. NULL on every line no merge altered.
     *
     * A STORED fact, unlike `stale`, which the cart DTO derives live at every
     * hydration and which therefore clears itself when stock returns. The
     * merge's decision — "your 7 became 3 because only 3 are in stock" — is not
     * re-derivable afterwards from catalogue state, and #104 requires it to be
     * VISIBLE rather than silently applied. It is cleared when the buyer next
     * sets this line's quantity explicitly: acting on the line IS the
     * acknowledgement, so no separate dismiss endpoint exists to keep honest.
     */
    mergeReviewReason: text({ enum: asEnumValues(CART_LINE_REVIEW_REASONS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongoose's `min: 1` on the embedded quantity.
    check('cart_items_quantity_check', sql`${t.quantity} > 0`),
    checkOneOf(
      'cart_items_merge_review_reason_check',
      t.mergeReviewReason,
      CART_LINE_REVIEW_REASONS,
    ),
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

/**
 * `favorites` — a buyer's saved LISTING; the unique pair makes the toggle
 * idempotent.
 *
 * #80 did not replace this table and did not fork it. A canonical PRODUCT save
 * is a different thing living in `product_saves` (`schema/productSaves.ts`),
 * and this row stays what it always was: one account's interest in one exact
 * native listing, which is the whole of #80's listing rules 1–3 — a handmade
 * item, an unmatched P2P listing, a used copy whose seller photographs are the
 * reason for saving.
 *
 * What #80 added is `save_intent`, and it answers listing rule 4: did the buyer
 * ASSERT that they meant this exact listing? `listing_save` is the honest
 * reading of every row written before #80 and of every write from a v1 client —
 * a listing was saved and nobody asked. `listing_pin` is the buyer answering.
 * The migration derives a product save from the first and skips the second, so
 * a pin is preserved as a pin (#80 migration rule 4) rather than being absorbed
 * into a model the buyer did not ask for.
 */
export const favorites = pgTable(
  'favorites',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** See the doc above. Defaulted so a v1 client's write is classified honestly. */
    saveIntent: text({ enum: asEnumValues(LISTING_SAVE_INTENTS) }).notNull().default('listing_save'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('favorites_save_intent_check', t.saveIntent, LISTING_SAVE_INTENTS),
    uniqueIndex('favorites_oxy_user_id_listing_id_key').on(t.oxyUserId, t.listingId),
    index('favorites_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    // The saved-items keyset (#80 API rule 7) reads `(created_at, id)` across
    // this table and `product_saves` as ONE ordering, so the tiebreaker has to
    // be in the index or every page boundary costs a sort.
    index('favorites_oxy_user_id_created_at_id_idx').on(
      t.oxyUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('favorites_listing_id_idx').on(t.listingId),
  ],
);

/**
 * `reviews` and its four #76 siblings live in `schema/reviews.ts`.
 *
 * The table was born here and moved out when #76 gave it targets in the
 * canonical graph: a scoped review references `canonical_products` and
 * `merchants`, both of which are exported AFTER this module in the barrel's
 * dependency order, so keeping the table here would have inverted that order
 * for every table in this file. The review domain owns its own file now, the
 * way every other domain in this schema does.
 */

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
