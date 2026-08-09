/**
 * Canonical product saves (#80): `product_saves`, `product_save_sources`,
 * `product_save_aggregates`.
 *
 * `favorites` (in `buyers.ts`) is the LISTING save and stays exactly where it
 * is. What #80 adds is the save of a canonical PRODUCT — the thing a buyer
 * actually wants when they tap a heart on a comparison page — plus the evidence
 * of which listing favorites produced which product save, plus the derived
 * counter.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **One save per (person, product).**
 *    `product_saves_oxy_user_id_canonical_product_id_key` is #80 model rule 9
 *    and acceptance 1 in one line: two favorited listings of one phone produce
 *    ONE save because the second insert has nowhere to go, not because a service
 *    checked first. Every write is `ON CONFLICT DO NOTHING`, so a repeated tap,
 *    a network retry and a migration replay all converge (acceptance 5).
 * 2. **A save names a PRODUCT and never an offer.** There is no `offer_id`
 *    column, no `listing_id` column and no price the save is contingent on — an
 *    offer expiring or a merchant leaving cannot invalidate a row that never
 *    referenced them. `reference_price_*` is the one price here and it is an
 *    OBSERVATION at save time, immutable, whose only consumer is "cheaper than
 *    when you saved it".
 * 3. **A split cannot silently pick a child** (#80 migration rule 8).
 *    `resolution_state = 'ambiguous_after_split'` requires
 *    `ambiguous_split_job_id`, both ways, by CHECK — so a save cannot be marked
 *    ambiguous without naming the job that made it so (which is what makes the
 *    two candidates recoverable), and cannot carry a job id while claiming to be
 *    resolved.
 * 4. **The counter is DERIVED and there is exactly one of it.**
 *    `product_save_aggregates` is the #76 `review_aggregates` posture: the
 *    aggregate is the authority, everything derives from `product_saves` and
 *    nothing increments, which is what makes a rebuild idempotent and drift
 *    detectable. There is deliberately NO `canonical_products.save_count`
 *    projection beside it — reviews have one only because the column predated
 *    the aggregate, and a second writer of one number is the disagreement these
 *    tables exist to prevent.
 * 5. **The counter cannot expose who saved something** (#80 privacy rule 1).
 *    `product_save_aggregates` has no actor column at all, and no view of it
 *    joins back — an absence, not a rule.
 *
 * ## What is deliberately NOT here
 *
 * - **No public saved list.** `visibility` is CHECKed against a ONE-member
 *   tuple, so `public` is not a value this column can hold; #80 privacy rule 6
 *   excludes a public saved-list profile from this issue, and widening the tuple
 *   plus shipping a migration is what introducing one would have to look like.
 * - **No price-alert subscription.** No table here can express one; #78 owns
 *   alerts and the DTO carries a named unsupported seam instead.
 * - **No display name, handle, email or avatar.** A save is an Oxy account id
 *   and a product id. That is what makes #80 privacy rule 5 a single scoped
 *   DELETE rather than an anonymization pass over copied profile fields.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  MAX_MONEY_MINOR_UNITS,
  PRODUCT_SAVE_RESOLUTION_STATES,
  PRODUCT_SAVE_SOURCE_CONTEXTS,
  PRODUCT_SAVE_VISIBILITIES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { catalogSplitJobs } from './curation';
import { favorites } from './buyers';
import { listings, productVariants } from './catalog';
import { merchants } from './merchants';

/**
 * `product_saves` — one Oxy account's standing interest in one canonical
 * product.
 *
 * ## `canonical_product_id` is RESTRICT, and `preferred_*` are too
 *
 * A canonical product is never hard-deleted — a merge stamps a tombstone and a
 * suppression hides — so RESTRICT costs nothing and states the fact: if some
 * future path ever tried to delete one, a person's saved list is not something
 * to take with it silently. `reviews.canonical_product_id` chose RESTRICT for
 * the same reason and this follows it rather than inventing a second answer.
 *
 * ## The reference price has no currency CHECK
 *
 * `reference_price_currency` is the OFFER's own currency, and `offers`'
 * `price_currency` is ADR 0002 D18's documented exception to the
 * `ALL_CURRENCY_CODES` CHECK: an external platform trades in whatever it trades
 * in. Copying the observation faithfully is the point; re-pricing it into a
 * presentment currency would bake an FX rate into a stored fact and make "has
 * the price moved" answer partly about the rate.
 *
 * The three columns move together (`num_nonnulls(...) in (0, 3)`) because a
 * price with no currency is not a price and a currency with no price is not an
 * observation. Absent means "no offer existed when this was saved", which is
 * `unknown as absence, never zero` — the reason there is no `0` default.
 */
export const productSaves = pgTable(
  'product_saves',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. Oxy owns identity. */
    oxyUserId: text().notNull(),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** #80 model rule 3. NULL means the buyer wants the product, any configuration. */
    preferredCanonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    /**
     * #80 model rule 4, a preferred condition SEGMENT.
     *
     * A GROUP and not one of #90's nine keys, deliberately: "I want a
     * refurbished one" is a filter over a segment, and pinning
     * `refurbished_seller` specifically would silently exclude
     * `refurbished_manufacturer` from a buyer who meant both. #90 states the
     * same rule for filters, price history and alerts.
     */
    preferredConditionGroup: text({ enum: asEnumValues(CONDITION_GROUPS) }),
    /** #80 model rule 4, a preferred seller of record. */
    preferredMerchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /** #80 model rule 5 — where the save was made from. */
    sourceContext: text({ enum: asEnumValues(PRODUCT_SAVE_SOURCE_CONTEXTS) }).notNull(),
    /** #80 model rule 8. One member; see the file header. */
    visibility: text({ enum: asEnumValues(PRODUCT_SAVE_VISIBILITIES) }).notNull().default('private'),
    /** #80 model rule 7 / migration rule 8. */
    resolutionState: text({ enum: asEnumValues(PRODUCT_SAVE_RESOLUTION_STATES) })
      .notNull()
      .default('resolved'),
    /**
     * The split that made this save ambiguous. RESTRICT: the job is the only
     * record of what the two candidates were, so it must outlive the ambiguity
     * it created.
     */
    ambiguousSplitJobId: text().references(() => catalogSplitJobs.id, { onDelete: 'restrict' }),
    /** The best offer's price when this was saved. See the doc above. */
    referencePriceAmount: bigint({ mode: 'number' }),
    referencePriceCurrency: text(),
    referencePriceObservedAt: timestamptz(),
    /**
     * #80 migration rule 5. Set exactly when the migration created this row.
     *
     * A CODE constant's value, not a foreign key into a versions table: the
     * mapping is a procedure, and a table would let somebody publish a version
     * whose rules nobody shipped (#60's `CATALOG_BACKFILL_MAPPING_VERSION`, same
     * reasoning). NULL on every save a person made themselves, which is what
     * makes "how many saves did buyers actually make" answerable.
     */
    migrationVersion: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('product_saves_oxy_user_id_check', sql`btrim(${t.oxyUserId}) <> ''`),
    checkOneOf('product_saves_source_context_check', t.sourceContext, PRODUCT_SAVE_SOURCE_CONTEXTS),
    checkOneOf('product_saves_visibility_check', t.visibility, PRODUCT_SAVE_VISIBILITIES),
    checkOneOf(
      'product_saves_resolution_state_check',
      t.resolutionState,
      PRODUCT_SAVE_RESOLUTION_STATES,
    ),
    checkOneOf(
      'product_saves_preferred_condition_group_check',
      t.preferredConditionGroup,
      CONDITION_GROUPS,
    ),
    /**
     * #80 migration rule 8, both ways. An ambiguous save NAMES the split that
     * made it so — which is what makes the two candidates recoverable without a
     * second table — and a resolved one cannot be carrying a stale job id that a
     * later reader would resurface as an unanswered question.
     */
    check(
      'product_saves_ambiguity_check',
      sql`(${t.resolutionState} = 'ambiguous_after_split') = (${t.ambiguousSplitJobId} is not null)`,
    ),
    check(
      'product_saves_reference_price_shape_check',
      sql`num_nonnulls(${t.referencePriceAmount}, ${t.referencePriceCurrency}, ${t.referencePriceObservedAt}) in (0, 3)`,
    ),
    check(
      'product_saves_reference_price_range_check',
      sql`${t.referencePriceAmount} is null
          or (${t.referencePriceAmount} >= 0
              and ${t.referencePriceAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))})`,
    ),
    check(
      'product_saves_reference_price_currency_check',
      sql`${t.referencePriceCurrency} is null or btrim(${t.referencePriceCurrency}) <> ''`,
    ),
    check(
      'product_saves_migration_version_check',
      sql`${t.migrationVersion} is null or btrim(${t.migrationVersion}) <> ''`,
    ),
    /** #80 model rule 9 and acceptance 1. See the file header. */
    uniqueIndex('product_saves_oxy_user_id_canonical_product_id_key').on(
      t.oxyUserId,
      t.canonicalProductId,
    ),
    /** The saved-list keyset, ordered exactly as it is read. */
    index('product_saves_oxy_user_id_created_at_id_idx').on(
      t.oxyUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    /** The counter rebuild's work list, and the merge's rehoming predicate. */
    index('product_saves_canonical_product_id_idx').on(t.canonicalProductId),
    index('product_saves_preferred_canonical_variant_id_idx')
      .on(t.preferredCanonicalVariantId)
      .where(sql`${t.preferredCanonicalVariantId} is not null`),
    index('product_saves_preferred_merchant_id_idx')
      .on(t.preferredMerchantId)
      .where(sql`${t.preferredMerchantId} is not null`),
    /** "Which of my saves are waiting on me" — a buyer's own inbox of one. */
    index('product_saves_ambiguous_idx')
      .on(t.oxyUserId, t.createdAt.desc())
      .where(sql`${t.resolutionState} = 'ambiguous_after_split'`),
  ],
);

/**
 * `product_save_sources` — which listing favorite produced which product save
 * (#80 migration rule 5).
 *
 * ## Why a child table and not two columns on the save
 *
 * "Several favorited listings for one product create ONE product save" (#80
 * migration rule 4) makes the relationship many-to-one by construction, so the
 * provenance cannot live on the save. It is also the record that makes a REPLAY
 * legible: `UNIQUE(favorite_id, migration_version)` means re-running one
 * mapping version over a favorite it already read writes nothing, and a NEW
 * mapping version can legitimately re-examine it — the `catalog_backfill_records`
 * key shape, one domain over.
 *
 * ## The two parents are treated DIFFERENTLY, and that is the whole design
 *
 * The FAVORITE cascades: a buyer removing their listing save takes the record
 * of it with them, which is what retention means for a row that exists only to
 * describe that favorite.
 *
 * The SAVE does not. `save_id` is `ON DELETE SET NULL`, so un-saving the
 * product leaves the record standing with no save attached — and
 * `productSaveSourceExists` then refuses to re-migrate that favorite under the
 * same mapping version. Cascading here instead would make a migration REPLAY
 * resurrect a save the buyer deliberately removed, which is worse than the
 * duplicate #80 migration rule 6 forbids: a duplicate is visible and a
 * resurrection looks like the buyer's own doing.
 *
 * A NEW mapping version can still re-examine the favorite, because the unique
 * spans the version — a new version is a new decision, which is exactly when
 * re-examining is right.
 *
 * ## Idempotency does not rest on this table either
 *
 * #80 migration rule 6 is held by `product_saves`' own unique and by the counter
 * being DERIVED. Stated separately because the favorite cascade above means
 * this record can disappear, and a rule that depended on it would then be
 * silently unenforced.
 *
 * ## Append-only, with two precise exceptions
 *
 * DELETE is refused while the favorite still EXISTS, so its cascade works and an
 * operator still cannot remove one record to hide it. UPDATE is refused except
 * for the ONE shape a referential action produces — `save_id` moving to NULL
 * with every other column unchanged.
 */
export const productSaveSources = pgTable(
  'product_save_sources',
  {
    id: generatedId(),
    /** NULL once the buyer un-saved the product. See the doc above. */
    saveId: text().references(() => productSaves.id, { onDelete: 'set null' }),
    favoriteId: text()
      .notNull()
      .references(() => favorites.id, { onDelete: 'cascade' }),
    /** Denormalized, so a record reads as "this listing" without a second join. */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * The native variant whose canonical attachment supplied the mapping.
     *
     * The evidence, not a convenience: a listing has many variants and only the
     * ATTACHED one justifies the product this save points at, so an operator
     * re-checking a migration decision can find the exact `native_listing_links`
     * row it read.
     */
    productVariantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    migrationVersion: text().notNull(),
    recordedAt: timestamptz().notNull(),
  },
  (t) => [
    check('product_save_sources_migration_version_check', sql`btrim(${t.migrationVersion}) <> ''`),
    /** One record per favorite per mapping version. See the doc above. */
    uniqueIndex('product_save_sources_favorite_id_migration_version_key').on(
      t.favoriteId,
      t.migrationVersion,
    ),
    /** "Which favorites is this save made of" — the saved-list representation read. */
    index('product_save_sources_save_id_idx').on(t.saveId),
    index('product_save_sources_listing_id_idx').on(t.listingId),
  ],
);

/**
 * `product_save_aggregates` — the ONE authority for how many people saved a
 * canonical product (#80 counter rules 1 and 3).
 *
 * Everything here DERIVES from `product_saves` and nothing increments, which is
 * what makes a rebuild idempotent (`rebuildProductSaveAggregate` runs the same
 * `count(*)` however many times it is called), makes drift DETECTABLE (a stored
 * number and a derived one can be compared) and makes a merge's rollup phase
 * correct without the double-count a summed merge would produce.
 *
 * `save_count` is the whole of it. There is no breakdown by condition, merchant
 * or source context, and no bucket small enough to name a person: #80 privacy
 * rule 1 says the count never exposes who saved something, and the enforcement
 * is that there is no column it could be exposed through.
 *
 * `rating_sample` is deliberately absent too — a save is not an opinion and
 * blending one into a quality signal is what #74 must not be handed by
 * accident. `product-save-isolation.test.ts` fails the build if a ranking
 * module reaches this table.
 */
export const productSaveAggregates = pgTable(
  'product_save_aggregates',
  {
    id: generatedId(),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    saveCount: integer().notNull().default(0),
    /** When this figure was last derived from `product_saves`. */
    lastRebuiltAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('product_save_aggregates_save_count_check', sql`${t.saveCount} >= 0`),
    /** ONE aggregate per product — the upsert's conflict target. */
    uniqueIndex('product_save_aggregates_canonical_product_id_key').on(t.canonicalProductId),
    /** The rebuild sweep's resumable cursor: oldest-rebuilt first (#76's device). */
    index('product_save_aggregates_last_rebuilt_at_idx').on(t.lastRebuiltAt),
  ],
);
