/**
 * Secondary category classification (#367 Workstream 1, ADR 0007 D2/D3/D4).
 *
 * The epic's box is *"Support selecting one primary category for a product and
 * justified secondary classifications where required."*
 *
 * ## There is no primary table here, and that is the design
 *
 * `listings.category_id` (`catalog.ts`) and `canonical_products.category_id`
 * (`canonicalCatalog.ts`) ARE the primary category. Both already exist, both
 * are `ON DELETE restrict`, both are indexed, both are guarded by
 * `mercaria_category_assignment_selectable`, and `listings.category_slugs` is
 * already materialized from one of them as a v1 read contract (ADR 0007 D13).
 *
 * "Exactly one primary" is therefore held by the strongest mechanism available
 * — a scalar column, in which two primaries have no row shape at all. It needs
 * no partial unique index, no `is_primary` flag, no ordering column and no
 * sweep. The alternative that gets reached for, a junction table with
 * `is_primary boolean`, is worse in three separate ways: a plain
 * `unique(subject_id, is_primary)` enforces NOTHING (Postgres treats NULLs as
 * distinct, and two `false` rows are legal anyway), so it needs a partial
 * unique `WHERE is_primary` to mean anything; it makes "the primary" a row that
 * can be deleted, leaving a subject whose twenty-odd readers still expect a
 * category; and it is a second answer to a question two live columns already
 * answer, which is the failure ADR 0007 D2 rejects a parallel
 * `taxonomy_categories` for one level up.
 *
 * So what is modelled here is only what did not exist: the SECONDARY filings.
 *
 * ## Two tables, not one, and not one polymorphic one
 *
 * ADR 0007 D4 rejects `(entity_type, entity_id)` outright: *"entity_id could
 * carry no foreign key, so every orphan would be invisible, and every read
 * would need a discriminator the planner cannot use."* That reasoning is about
 * localization and applies here unchanged, so the shape is one table per
 * subject with a real foreign key each.
 *
 * BOTH subjects get one, because the two acts are different and neither
 * substitutes for the other — the division the schema already states, in the
 * comment on the trigger that guards both primary columns with one function:
 *
 * > TWO tables and one function: `listings.category_id` is a seller filing a
 * > product, `canonical_products.category_id` is the catalogue filing one.
 *
 * Canonical-only was rejected on a PERMANENT exclusion rather than a migration
 * lag: `services/backfill/stages/provisional-products.ts` returns
 * `p2p_left_unattached` for every listing whose `owner_type` is not `store`,
 * and calls it "a successful outcome, not a gap" (D23 clause 7, #60 acceptance
 * 3). A P2P seller's item is never attached to a canonical product, so a
 * canonical-only model would leave the whole P2P half of the marketplace
 * unable to carry a second filing at all. Listing-only was rejected because it
 * makes every seller of one phone re-state the same regulatory filing, and
 * because it re-entrenches the listing-first catalogue this epic migrates away
 * from.
 *
 * The accepted cost is DUPLICATION where a store listing is linked to a
 * canonical product: both may carry a secondary saying the same thing. Nothing
 * here derives, copies or inherits one from the other, deliberately — a
 * seller's filing and the catalogue's filing are assertions by different
 * accountable parties, and `justified_by` records which.
 *
 * `canonical_product_families.category_id` gets no secondaries, following the
 * exclusion `mercaria_category_assignment_selectable` already makes for the
 * same reason: a family is itself a grouping.
 *
 * ## Where each invariant lives, and why
 *
 * A CHECK may not read another row, so anything about the CATEGORY or about the
 * subject's PRIMARY is a trigger — the resolution ADR 0007 D2 reaches twice, for
 * selectability and for cycles.
 *
 * | Invariant | Mechanism |
 * |---|---|
 * | reason ∈ the closed set | CHECK (this file) |
 * | justification present and non-empty | CHECK (this file) |
 * | `scheme_ref` present ⇔ the reason cites a scheme | biconditional CHECK |
 * | `justified_by` present and non-empty | CHECK |
 * | one filing per (subject, category) | UNIQUE index |
 * | the category is `selectable` | the EXISTING `mercaria_category_assignment_selectable`, mounted here too |
 * | the category's lifecycle is assignable | `mercaria_listing_secondary_category_guard` and its canonical-product twin |
 * | a secondary requires a primary | the same pair |
 * | a secondary is not the primary, nor its ancestor or descendant | that pair (child side) AND `mercaria_listing_primary_category_guard` plus its twin (parent side), both over `mercaria_category_kinship` |
 *
 * ## "No primary, but some secondaries" is REFUSED, deliberately
 *
 * All three category-assignment columns in this schema are NULLABLE
 * (`catalog.ts` for listings, `canonicalCatalog.ts` for canonical products and
 * families) — the seller-facing write schema requires a category, but the
 * COLUMN does not, and pre-#367 rows predate any of it. So "zero primary, two
 * secondaries" is representable at the column level and has to be refused
 * somewhere.
 *
 * It is refused here, because it is the exact ambiguity this box exists to
 * remove and because it fails SILENTLY: every reader that resolves "the
 * category" gets NULL and takes its unclassified path, while the row visibly
 * carries filings. Nobody sees a contradiction — they see an unclassified
 * product that has classifications, and the two facts are in different
 * queries.
 *
 * `mercaria_listing_secondary_category_guard` (and its canonical-product twin)
 * therefore refuses a secondary whose subject has no primary, while
 * `mercaria_listing_primary_category_guard` and ITS twin refuse clearing a
 * primary to NULL while secondaries exist. The read model says the
 * same thing in its own idiom: `ProductClassification`'s `unclassified` branch
 * has NO `secondary` property, so a consumer cannot construct the state either.
 *
 * **The parent side is the half that gets forgotten.** Guarding only the child
 * makes the invariant hold at insert and then breaks silently the first time
 * somebody re-points `listings.category_id` at a node one of its own
 * secondaries already names — which is exactly "a secondary silently becoming
 * the primary". So `mercaria_listing_primary_category_guard` is mounted on
 * `listings`, its twin on `canonical_products`, both for
 * `UPDATE OF category_id`, and each REFUSES rather
 * than deleting the collided secondary: deleting one would destroy a
 * justification somebody is accountable for, as a side effect of an unrelated
 * edit.
 *
 * Both guards read `categories.ancestor_ids`, which ADR 0007 D2 makes the
 * ancestry authority, so each direction is one array membership test and
 * neither needs a recursive read.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  SECONDARY_CLASSIFICATION_CITED_REASONS,
  SECONDARY_CLASSIFICATION_REASONS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns.js';
import { categories, listings } from './catalog.js';
import { canonicalProducts } from './canonicalCatalog.js';

/**
 * The columns both subject tables share, verbatim.
 *
 * A function rather than a spread constant because drizzle's column builders
 * are STATEFUL — a builder object reused across two `pgTable` calls carries the
 * first table's binding into the second, which produces a schema that generates
 * cleanly and addresses the wrong table. Calling the builders afresh per table
 * is the only shape that cannot do that.
 */
function classificationColumns() {
  return {
    id: generatedId(),
    /**
     * The category this is a SECONDARY filing under.
     *
     * `restrict`, matching every other reference into `categories` in this
     * schema: nothing deletes a category, and a filing may not be orphaned.
     */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /** Why a second filing is warranted. See `SecondaryClassificationReason`. */
    reason: text({ enum: asEnumValues(SECONDARY_CLASSIFICATION_REASONS) }).notNull(),
    /**
     * What was decided, in words.
     *
     * NOT NULL with a non-empty CHECK, which is the whole difference between
     * this requirement and a decorative one. A nullable note that every writer
     * leaves empty satisfies the word "justified" and nothing else, so there is
     * no row shape for an unjustified filing.
     */
    justification: text().notNull(),
    /**
     * The external scheme relied on — a regulation, a tax code, a safety
     * standard.
     *
     * Present EXACTLY when the reason names an external authority (a
     * biconditional CHECK, not a floor). A scheme has a name; a judgement does
     * not, and letting `multi_function_product` carry one would produce rows
     * whose "citation" is a sentence typed into a field named after a registry.
     */
    schemeRef: text(),
    /**
     * The Oxy account that made the filing.
     *
     * No foreign key — Oxy owns identity and there is no `users` table
     * (CONVENTIONS.md). NOT NULL and non-empty: an unattributable justification
     * is not one.
     */
    justifiedBy: text().notNull(),
    justifiedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

/**
 * `listing_secondary_categories` — one seller's second filing for one listing.
 *
 * `cascade` on the listing: a classification of a deleted listing is
 * meaningless and exists only to point at it, which is exactly the case
 * CONVENTIONS.md assigns a cascade to. Contrast the `restrict` on
 * `category_id`, which points the other way at a shared definition.
 */
export const listingSecondaryCategories = pgTable(
  'listing_secondary_categories',
  {
    ...classificationColumns(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
  },
  (t) => [
    /**
     * One filing per (listing, category). A repeat is a correction to the
     * existing row, never a second row saying the same thing for a different
     * reason — two live justifications for one filing is precisely the state
     * nobody could act on.
     */
    uniqueIndex('listing_secondary_categories_key').on(t.listingId, t.categoryId),
    /** The reverse read: what is filed under this node. Serves the operator surface. */
    index('listing_secondary_categories_category_idx').on(t.categoryId),
    checkOneOf(
      'listing_secondary_categories_reason_check',
      t.reason,
      SECONDARY_CLASSIFICATION_REASONS,
    ),
    check(
      'listing_secondary_categories_justification_present_check',
      sql`length(btrim(${t.justification})) > 0`,
    ),
    check(
      'listing_secondary_categories_justified_by_present_check',
      sql`length(btrim(${t.justifiedBy})) > 0`,
    ),
    /**
     * Present exactly when the reason cites an external authority, and non-empty
     * when present. Two conditions in one constraint because a `scheme_ref` of
     * `'   '` satisfies "is not null" and cites nothing.
     */
    check(
      'listing_secondary_categories_scheme_ref_check',
      sql`(${t.schemeRef} is not null and length(btrim(${t.schemeRef})) > 0)
        = (${t.reason} in (${sql.raw(inList(SECONDARY_CLASSIFICATION_CITED_REASONS))}))`,
    ),
  ],
);

/**
 * `canonical_product_secondary_categories` — the catalogue's second filing for
 * one canonical product.
 *
 * Identical shape to its listing sibling, which is the point: the two acts are
 * different but the RECORD of one is the same five facts, so a reviewer reading
 * either table reads the same columns.
 */
export const canonicalProductSecondaryCategories = pgTable(
  'canonical_product_secondary_categories',
  {
    ...classificationColumns(),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('canonical_product_secondary_categories_key').on(
      t.canonicalProductId,
      t.categoryId,
    ),
    index('canonical_product_secondary_categories_category_idx').on(t.categoryId),
    checkOneOf(
      'canonical_product_secondary_categories_reason_check',
      t.reason,
      SECONDARY_CLASSIFICATION_REASONS,
    ),
    check(
      'canonical_product_secondary_categories_justification_present_check',
      sql`length(btrim(${t.justification})) > 0`,
    ),
    check(
      'canonical_product_secondary_categories_justified_by_present_check',
      sql`length(btrim(${t.justifiedBy})) > 0`,
    ),
    check(
      'canonical_product_secondary_categories_scheme_ref_check',
      sql`(${t.schemeRef} is not null and length(btrim(${t.schemeRef})) > 0)
        = (${t.reason} in (${sql.raw(inList(SECONDARY_CLASSIFICATION_CITED_REASONS))}))`,
    ),
  ],
);
