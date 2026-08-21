/**
 * The sellable catalogue: `categories`, `listings`, `listing_images`,
 * `listing_options`, `listing_external_refs`, `product_variants`,
 * `product_variant_option_values`, `inventory_levels`.
 *
 * Three of this schema's four "shape changes" live here, and each replaces a
 * Mongo mechanism that has no direct Postgres equivalent:
 *
 *  - the `{title, description, tags}` TEXT index becomes a generated `tsvector`
 *    plus a GIN index;
 *  - the `2dsphere` index on a GeoJSON point becomes named `longitude` /
 *    `latitude` columns plus a GENERATED `geography` and a GiST index;
 *  - the `pre('validate')` owner-exclusivity hook becomes a CHECK, which unlike
 *    a hook cannot be bypassed by `updateOne`, by the backfill, or by `psql`.
 *
 * `Listing.collectionIds` is NOT here — it becomes the `listing_collections`
 * junction table in `merchandising.ts`, alongside the collection that
 * materializes it.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createdAt, generatedId, geography, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  ALL_LISTING_STATUSES,
  CATEGORY_KEY_PATTERN,
  CATEGORY_LIFECYCLES,
  CONDITION_ASSERTIONS,
  CONNECTOR_PROVIDER_IDS,
  ITEM_CONDITION_KEYS,
  LISTING_ARCHIVE_CAUSES,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
} from '@mercaria/shared-types';
import type { CategoryLifecycle, ItemConditionKey, ListingOwnerType } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { connections } from './connectors';
import { locations, stores } from './stores';
// `productTypeDefinitions` for `listings.product_type_definition_id` (ADR 0007
// D13). This is a CIRCULAR module import — `productTypes.ts` imports
// `categories` from this file — and it is safe only because both directions are
// drizzle's LAZY `references(() => …)` callbacks, evaluated long after both
// modules have finished. It is verified rather than assumed: this repository has
// a measured case of drizzle-kit silently emitting NO `ADD CONSTRAINT` and NO
// snapshot entry for a circular foreign key (`awin_advertisers.activating_sample_id`),
// so the generated SQL and the snapshot are both checked for this one.
import { productTypeDefinitions } from './productTypes';

/** `Listing.ownerType`. */
export const LISTING_OWNER_TYPES: readonly ListingOwnerType[] = ['user', 'store'];

/**
 * The value set `listings.condition` accepts — #90's nine taxonomy keys.
 *
 * The two-phase migration is what got here: `0030` (`pre`) widened the CHECK to
 * a SUPERSET including the legacy `'used'` and backfilled every row, so the
 * previous image could keep writing while it rolled; `0031` (`post`) narrowed it
 * to this tuple, which breaks exactly that write and is why it is a `post`
 * statement rather than an additive one.
 */
export const LISTING_CONDITION_VALUES: readonly ItemConditionKey[] = ITEM_CONDITION_KEYS;

/** `Listing.conditionAssertion` — how the stored key came to be asserted. */
export const LISTING_CONDITION_ASSERTIONS = CONDITION_ASSERTIONS;

/**
 * The value set `categories.lifecycle` accepts — ADR 0007 D2's five states.
 *
 * Named here for the same reason `LISTING_CONDITION_VALUES` is: the tuple that
 * types the column and the tuple the CHECK is rendered from must be one value,
 * because `text({ enum })` alone emits no DDL at all.
 */
export const CATEGORY_LIFECYCLE_VALUES: readonly CategoryLifecycle[] = CATEGORY_LIFECYCLES;

/**
 * `categories` — the marketplace taxonomy, a tree via `parentId`.
 *
 * ## There is ONE category table, and #367 widened it in place
 *
 * ADR 0007 D2: a parallel `taxonomy_categories` would mean every listing,
 * collection rule, search filter and connector mapping in this repository has
 * two possible answers to "what is this". So the universal taxonomy is this
 * table with six more columns, and `db/taxonomy/taxonomyRepository.ts` is its
 * single write chokepoint (pinned by `taxonomy-write-chokepoint.test.ts`).
 *
 * ## Identity is `id` and `key`. A name and a slug are presentation.
 *
 * `key` is the stable machine key (D1) — lowercase dotted segments, in a
 * documented namespace, so a seed, a fixture, an external mapping and an
 * operator's tooling can name a concept without embedding a uuid. It is FROZEN
 * after insert by `mercaria_category_key_frozen`, because a renamed key is
 * indistinguishable from a different concept to everything that cited it; a
 * category whose key was wrong is deprecated and superseded instead.
 *
 * ## Two materialized paths, and only one of them is the authority
 *
 * `ancestorIds` (D2) is the ancestry, root-first, excluding the row itself, with
 * a GIN index — so "descendants of X" and "breadcrumb of X" are each one
 * statement. `ancestorSlugs` is the SAME path spelled in slugs and is retained
 * as a v1 read contract (D13): `listings.category_slugs` is materialized from
 * it and the browse reads still query it by element. It is superseded, not
 * dropped, and retires in a later `post` migration once no reader remains.
 * Both are written by the one repository from the parent's own arrays, so they
 * cannot disagree.
 *
 * A materialized path rather than a closure table, deliberately: the shape is
 * already here and already indexed, the tree is shallow and small, and a closure
 * table is a second representation of one fact. ADR 0007 D2 makes the choice
 * PROVISIONAL on #61's benchmark and says the ADR is amended before an
 * alternative is adopted, never after.
 *
 * ## `is_active` is a derived read now, and stays a column
 *
 * `lifecycle` is the authority. `is_active` is `lifecycle = 'published'`,
 * applied in one place (`CATEGORY_ACTIVE_LIFECYCLES` in shared-types, read by
 * the repository) and retained as a v1 contract column (D13) because five
 * services and every browse read filter on it today.
 *
 * It is NOT a generated column and there is NO cross-column CHECK tying it to
 * `lifecycle` — yet. Both would break a write the previously serving image
 * performs (`insertCategory` supplies `is_active` and knows no lifecycle), which
 * makes them `post`-phase statements and this migration is `pre`. The follow-up
 * is named in the migration header: once no image writes `is_active` directly,
 * `categories_is_active_derived_check` states it at the row.
 */
export const categories = pgTable(
  'categories',
  {
    id: generatedId(),
    /**
     * The stable machine key (ADR 0007 D1) — `electronics.phones.smartphones`.
     * Frozen after insert by trigger; unique across the taxonomy.
     */
    key: text().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    /**
     * The parent category, or NULL for a top-level one.
     *
     * `restrict` rather than `cascade` or `set null`: nothing deletes a category
     * today, and if that ever changes, silently re-parenting a whole subtree to
     * the root (`set null` — where NULL already means "top-level") or silently
     * destroying it (`cascade`) are both worse than refusing.
     */
    parentId: text().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    /** Root-first, excluding this row. The v1 read contract (D13). */
    ancestorSlugs: text().array().notNull().default(sql`'{}'::text[]`),
    /** Root-first, excluding this row. The authority (D2). */
    ancestorIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Where this category sits in its life. See `CategoryLifecycle`. */
    lifecycle: text({ enum: asEnumValues(CATEGORY_LIFECYCLE_VALUES) })
      .notNull()
      .default('published'),
    /**
     * Whether a product may be filed under this node.
     *
     * A structural node — a root, a grouping level — is not a valid product
     * assignment (D2), and `mercaria_category_assignment_selectable` refuses one
     * on `listings` and `canonical_products`. Distinct from `lifecycle`:
     * suppression decides whether shoppers SEE a node, selectability decides
     * whether a product may be FILED under it, and the connector holding pen
     * (suppressed, selectable) and a grouping root (published, not selectable)
     * each need one without the other.
     */
    selectable: boolean().notNull().default(true),
    /** Set exactly when `lifecycle = 'merged'` — a biconditional CHECK. */
    mergedIntoCategoryId: text().references((): AnyPgColumn => categories.id, {
      onDelete: 'restrict',
    }),
    /** A dated cutover, stated on the row rather than in a job's memory (D2). */
    effectiveFrom: timestamptz(),
    effectiveTo: timestamptz(),
    imageUrl: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    imageFileId: text(),
    position: integer().notNull().default(0),
    /** DERIVED from `lifecycle` by the repository; a v1 read contract (D13). */
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('categories_slug_key').on(t.slug),
    uniqueIndex('categories_key_key').on(t.key),
    index('categories_parent_id_position_idx').on(t.parentId, t.position),
    index('categories_ancestor_slugs_idx').using('gin', t.ancestorSlugs),
    index('categories_ancestor_ids_idx').using('gin', t.ancestorIds),
    checkOneOf('categories_lifecycle_check', t.lifecycle, CATEGORY_LIFECYCLE_VALUES),
    /**
     * The key's shape. The pattern carries NO backslash on purpose — see
     * `CATEGORY_KEY_PATTERN`; a `\.` is consumed by the JS template literal
     * before drizzle sees it and would reach Postgres as a bare `.`, which
     * matches any character and admits `Electronics/Phones`.
     */
    check('categories_key_format_check', sql`${t.key} ~ ${sql.raw(`'${CATEGORY_KEY_PATTERN}'`)}`),
    /**
     * Merge is stated exactly once. Both halves of the biconditional matter: a
     * `merged` row with no successor is a dead end nothing can resolve, and a
     * successor on a `published` row is a merge that never happened.
     */
    check(
      'categories_merged_into_check',
      sql`(${t.mergedIntoCategoryId} is not null) = (${t.lifecycle} = 'merged')`,
    ),
    /**
     * What ONE ROW can say about itself belongs in a CHECK; what the TREE says
     * needs a trigger, because a CHECK may not read another row. So
     * self-parenting and merging into oneself are here, and cycles of length two
     * or more and merging into a DESCENDANT are
     * `mercaria_category_hierarchy_guard`.
     */
    check('categories_parent_not_self_check', sql`${t.parentId} is distinct from ${t.id}`),
    check(
      'categories_merged_into_not_self_check',
      sql`${t.mergedIntoCategoryId} is distinct from ${t.id}`,
    ),
    check(
      'categories_effective_window_check',
      sql`${t.effectiveTo} is null or ${t.effectiveFrom} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * `listings` — the core sellable product.
 *
 * ## Owner exclusivity is a CHECK, not a hook
 *
 * Mongoose enforced `ownerType: 'user' ⇒ oxyUserId set, storeId unset` (and the
 * mirror) in a `pre('validate')` hook. A hook runs on `save()` and NOT on
 * `updateOne`/`findOneAndUpdate`/`insertMany`, which is most of the write paths
 * in this codebase, and not at all during a backfill. As a CHECK the invariant
 * holds against every writer including `psql`.
 *
 * ## Denormalized facets stay denormalized
 *
 * `priceRange`, `hasInventory` and `variantCount` are computed from the
 * listing's variants by `catalog-write.syncListingFacets`. They are NOT
 * generated columns: a generated column may only read its own row, and these
 * read the variant rows. `price_range_min_amount` is a real sort and filter key
 * (`search.service`, `collection.service`, `feed.service`), so it earns its
 * index.
 */
export const listings = pgTable(
  'listings',
  {
    id: generatedId(),
    ownerType: text({ enum: asEnumValues(LISTING_OWNER_TYPES) }).notNull(),
    /** An Oxy account id — no foreign key. Set iff `ownerType = 'user'`. */
    oxyUserId: text(),
    /** Set iff `ownerType = 'store'`. */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    /** NOT NULL with NO default — see `stores.description` for why `''` is not one. */
    description: text().notNull(),
    /** The #90 taxonomy key. Widened from the binary `new | used` by #90's two migrations. */
    condition: text({ enum: asEnumValues(LISTING_CONDITION_VALUES) }).notNull(),
    /**
     * How this condition came to be asserted (#90).
     *
     * NO DEFAULT, deliberately: every writer states it, and a default would let
     * a future insert that forgot record a listing as migrated when a human
     * chose it. `0030` (`pre`) gave the column a `migrated_binary` default so
     * the previous image's inserts could still land during the rollout, and
     * `0031` (`post`) drops it — which is a `post` statement precisely because
     * it breaks that image's write.
     */
    conditionAssertion: text({ enum: asEnumValues(LISTING_CONDITION_ASSERTIONS) }).notNull(),
    /** The external source's own wording, when the key came from one (#90 evidence 5). */
    conditionSourceLabel: text(),
    /**
     * When the seller affirmatively acknowledged the disclosed defects and
     * missing parts (#90 policy rule 2).
     *
     * A timestamp rather than a boolean: "they agreed" and "they agreed at this
     * point, to what was disclosed then" are different facts, and a dispute
     * needs the second one.
     */
    conditionAcknowledgedAt: timestamptz(),
    status: text({ enum: asEnumValues(ALL_LISTING_STATUSES) }).notNull().default('draft'),

    /**
     * What moved this listing into `archived`, and what it was immediately
     * before — the status PROVENANCE of #390.
     *
     * `listingRepository` DERIVES both, in the same statement that writes the
     * status, from the row's own pre-update `status`. No caller states the
     * previous status and no caller can forget it: the `published_at`
     * arrangement one column over, for the same reason, and gated by the same
     * chokepoint test.
     *
     * NULL on both is not a fourth cause, it is the ABSENCE of a record, and
     * every reader must treat it as such:
     *
     *  - on a listing that is not `archived`, they were cleared by the write
     *    that moved it out, so there is nothing to read;
     *  - on an `archived` listing they mean **we do not know** — the row was
     *    archived before #390 shipped. Nothing was backfilled, deliberately:
     *    the two cases this exists to separate are separated by no evidence
     *    that survives anywhere, so a backfill could only invent one, and
     *    inventing the connector half is exactly the wrong guess to make (it
     *    would republish a listing its merchant deleted). Such a listing keeps
     *    today's behaviour precisely: it stays archived until somebody says
     *    otherwise.
     *
     * They are NOT tied to `status` by a biconditional CHECK, and that is the
     * reason: every pre-#390 archived row would violate it on the deploy that
     * added it, so the constraint would need a backfill of a fact nobody has.
     * A value CHECK on each column is additive and holds from the first row.
     */
    archivedBy: text({ enum: asEnumValues(LISTING_ARCHIVE_CAUSES) }),
    /**
     * The status held immediately before the archive recorded in `archived_by`.
     *
     * What a restore puts BACK, so it is never a hardcoded `active` — the
     * `moderation_enforcements.previous_state_listing_status` rule, which exists
     * because a listing imported under `autoPublish: false` has never been on
     * sale and un-archiving it to `active` would put it there.
     *
     * NULL beside a non-null `archived_by` is a real state and means the write
     * was not a TRANSITION into `archived` (the row was already archived), so
     * there is no previous status to name. A restore refuses it rather than
     * guessing.
     */
    archivedFromStatus: text({ enum: asEnumValues(ALL_LISTING_STATUSES) }),

    /**
     * `restrict`: nothing deletes a category, and `set null` would promote an
     * orphaned listing into "uncategorized", which is a real and different state.
     */
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    /** The category's own slug plus every ancestor's — denormalized for browse. */
    categorySlugs: text().array().notNull().default(sql`'{}'::text[]`),
    tags: text().array().notNull().default(sql`'{}'::text[]`),

    ...optionalMoney('priceRangeMin'),
    ...optionalMoney('priceRangeMax'),
    hasInventory: boolean().notNull().default(false),
    variantCount: integer().notNull().default(0),

    /**
     * The listing's location, as NAMED coordinates rather than a GeoJSON array.
     *
     * Mongo stored `coordinates: [lng, lat]`, and a positional pair is the one
     * shape where a swap does not look wrong: it yields a plausible point in the
     * wrong hemisphere. Naming the two columns and GENERATING the point from
     * them states the order in exactly one place.
     */
    longitude: doublePrecision(),
    latitude: doublePrecision(),
    /**
     * The PostGIS point, GENERATED — never written.
     *
     * `ST_MakePoint(lon, lat)::geography` is IMMUTABLE in PostGIS 3.5, which a
     * generated column requires. Because it is generated, the coordinates and
     * the point cannot disagree: there is no write path, including the backfill,
     * that can produce a row where they do.
     */
    geo: geography().generatedAlwaysAs(
      (): SQL =>
        sql`case when ${listings.longitude} is null or ${listings.latitude} is null then null
             else st_makepoint(${listings.longitude}, ${listings.latitude})::geography end`,
    ),

    vendor: text(),
    /**
     * The connector's own free-text product type (Shopify's `product_type`).
     *
     * NOT the versioned schema — see `productTypeDefinitionId` directly below.
     * The two sit together deliberately: this is a string a platform sent, and
     * that is a citation of an authoring contract. Nothing derives one from the
     * other, and a reader who conflates them would take a Shopify string for a
     * schema version.
     */
    productType: text(),
    /**
     * The EXACT product-type version this listing was authored under — ADR 0007
     * D5/D10's pin for the PUBLISHED write, and D13's `listings` widening.
     *
     * NULLABLE, and that is the same ruling `native_listing_variant_axes` made
     * one table over: a connector listing and every pre-#367 row was authored
     * under no schema at all, so a NOT NULL column would need a backfill that
     * INVENTS a pin. Nothing distinguishes a listing authored under a product
     * type from one that never had a schema, and a guessed pin is a false claim
     * about how a record was authored — the `listings.published_at` no-backfill
     * ruling, for the same reason.
     *
     * `restrict`, matching `product_type_fields.attribute_definition_id`: a
     * version a live listing cites is not deletable, and #367 step 3's own
     * trigger already refuses to delete a published one.
     *
     * There are deliberately NO denormalized `key`/`version` citation columns
     * beside it, unlike `product_type_fields`. Those exist there only because a
     * CHECK cannot contain a subquery; the one rule wanted here — that a
     * listing's axes cite the same version the listing does — is CROSS-ROW and
     * therefore a trigger, which reads the referenced row directly.
     *
     * `mercaria_listing_product_type_pin_not_cleared` permits NULL → a value (a
     * first pin) and value → value (which IS the deliberate migration ADR 0007
     * D10 describes) and REFUSES value → NULL: a pin that can be erased is not a
     * pin, and erasing one would destroy the evidence of which rules a stored
     * answer was recorded under.
     */
    productTypeDefinitionId: text().references(() => productTypeDefinitions.id, {
      onDelete: 'restrict',
    }),
    /** URL-safe handle for store products; unique per store WHEN SET. */
    handle: text(),
    seoTitle: text(),
    seoDescription: text(),

    // `source` — connector provenance, a fixed four-field object, flattened.
    // Present only on listings PULLED from an external platform. Distinct from
    // `listing_external_refs`, which records where this listing was PUSHED to.
    /**
     * `restrict`: a listing outlives its connector, and NULL already means
     * "Mercaria-native, never imported" — so `set null` would silently rewrite a
     * listing's provenance into a claim that it was authored here.
     */
    sourceConnectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    sourceProvider: text({ enum: asEnumValues(CONNECTOR_PROVIDER_IDS) }),
    /** The external platform's own product id — a foreign system's key. */
    sourceExternalId: text(),
    sourceExternalUpdatedAt: timestamptz(),

    /** Field names locally edited and PINNED against connector re-sync. */
    overriddenFields: text().array().notNull().default(sql`'{}'::text[]`),
    /** Average review score, 0 when unrated — a computed mean, hence a float. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    favoriteCount: integer().notNull().default(0),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The `{title: 'text', description: 'text', tags: 'text'}` Mongo index.
     *
     * The two-argument `to_tsvector('english', …)` with a LITERAL config is
     * required throughout: the one-argument form reads
     * `default_text_search_config` at runtime, making it STABLE, and Postgres
     * refuses a STABLE expression in a generated column.
     *
     * ## Tags go through the SAME analyzer as the prose, and that took a function
     *
     * The first cut reached for `array_to_tsvector`, which is IMMUTABLE and
     * therefore accepted — but it stores each element as a lexeme VERBATIM, with
     * no stemming and no case folding. So a listing tagged `Handmade` was
     * unreachable by "handmade", and `bikes` never matched `Bikes`: a real
     * narrowing against Mongo's `$text`, which DID stem array elements.
     *
     * Feeding the array through `to_tsvector('english', …)` instead needs the
     * elements joined first, and neither obvious spelling is allowed:
     * `array_to_string(anyarray, text)` is STABLE (its element→text output
     * function is not immutable for every type it accepts) and `tags::text` is
     * rejected outright with `generation expression is not immutable`.
     * `mercaria_immutable_array_to_string(text[], text)` — created in
     * `drizzle/0003_tag_search_stemming.sql` — is a one-line SQL wrapper narrowed
     * to `text[]`, where the conversion genuinely is immutable, so it can be
     * declared as such honestly rather than by assertion.
     *
     * `coalesce` on every input, not only the nullable one: concatenating a NULL
     * into a tsvector yields NULL for the whole column, so this does not rely on
     * `title`/`description` staying NOT NULL through a future migration.
     */
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${listings.title}, '')) ||
            to_tsvector('english', coalesce(${listings.description}, '')) ||
            to_tsvector('english', mercaria_immutable_array_to_string(coalesce(${listings.tags}, '{}'::text[]), ' '))`,
    ),
  },
  (t) => [
    checkOneOf('listings_owner_type_check', t.ownerType, LISTING_OWNER_TYPES),
    checkOneOf('listings_condition_check', t.condition, LISTING_CONDITION_VALUES),
    checkOneOf(
      'listings_condition_assertion_check',
      t.conditionAssertion,
      LISTING_CONDITION_ASSERTIONS,
    ),
    /**
     * #90 MIGRATION RULE 2, as a constraint rather than as care taken in a
     * backfill: an UNREFINED assertion may only carry an unrefined key.
     *
     * `migrated_binary` and `legacy_client_binary` both mean "something coarse
     * produced this and nobody has looked at the nine keys since", and
     * `UNREFINED_CONDITION_KEYS` is `{new, used_good}` — `used_like_new` is
     * deliberately not in it. So the legacy `used` can never become "like new",
     * whether the writer is the migration, a v1 mobile client, a service bug or
     * a `psql` session. Both tuples come from `@mercaria/shared-types`, so the
     * rule the type system states and the rule the database enforces are the
     * same list.
     */
    check(
      'listings_unrefined_condition_check',
      sql`${t.conditionAssertion} not in (${sql.raw(
        UNREFINED_CONDITION_ASSERTIONS.map((a) => `'${a}'`).join(', '),
      )})
          or ${t.condition} in (${sql.raw(
            UNREFINED_CONDITION_KEYS.map((k) => `'${k}'`).join(', '),
          )})`,
    ),
    // A source's own wording belongs only to a condition a source declared.
    // Without this a seller-declared listing could carry a label claiming an
    // external platform said something it never did.
    check(
      'listings_condition_source_label_check',
      sql`${t.conditionSourceLabel} is null or ${t.conditionAssertion} = 'source_declared'`,
    ),
    // `restricted` MUST be in this list. It is written only by moderation
    // enforcement, via `updateOne`, which runs no Mongoose validator — so a CHECK
    // that omitted it would silently disarm every takedown.
    checkOneOf('listings_status_check', t.status, ALL_LISTING_STATUSES),
    // #390's status provenance. Both are nullable and `x in (…)` is NULL — hence
    // accepted — for a NULL `x`, so every pre-existing row satisfies these and
    // the migration that adds them is additive (`pre`).
    checkOneOf('listings_archived_by_check', t.archivedBy, LISTING_ARCHIVE_CAUSES),
    checkOneOf('listings_archived_from_status_check', t.archivedFromStatus, ALL_LISTING_STATUSES),
    // A previous status without an archive record is not a weaker fact, it is an
    // incoherent one: it names what a transition replaced while saying no
    // transition happened. The converse is deliberately allowed — see the column.
    check(
      'listings_archived_from_status_needs_cause_check',
      sql`${t.archivedFromStatus} is null or ${t.archivedBy} is not null`,
    ),
    checkOneOf('listings_source_provider_check', t.sourceProvider, CONNECTOR_PROVIDER_IDS),
    ...currencyChecks('listings', [t.priceRangeMinCurrency, t.priceRangeMaxCurrency]),

    // The `pre('validate')` owner-exclusivity hook, as a constraint.
    check(
      'listings_owner_exclusivity_check',
      sql`(${t.ownerType} = 'user' and ${t.oxyUserId} is not null and ${t.storeId} is null)
          or (${t.ownerType} = 'store' and ${t.storeId} is not null and ${t.oxyUserId} is null)`,
    ),
    // A point is either fully specified or absent — never half a coordinate pair.
    check(
      'listings_coordinates_check',
      sql`(${t.longitude} is null) = (${t.latitude} is null)`,
    ),

    // Keyset-paginated browse feeds. Each is the feed's ORDER BY, in that exact
    // column order and direction — anything else cannot serve the sort.
    index('listings_status_published_at_id_idx').on(
      t.status,
      t.publishedAt.desc(),
      t.id.desc(),
    ),
    index('listings_status_category_id_published_at_id_idx').on(
      t.status,
      t.categoryId,
      t.publishedAt.desc(),
      t.id.desc(),
    ),
    index('listings_status_price_published_at_idx').on(
      t.status,
      t.priceRangeMinAmount,
      t.publishedAt.desc(),
    ),
    // #90 acceptance 2: filtering by condition must be independent of every other
    // facet, which means it needs its own leading-column index rather than
    // riding the category one and filtering on the heap. Same shape as the
    // browse feeds above — the filter, then the ORDER BY, in that exact order.
    index('listings_status_condition_published_at_id_idx').on(
      t.status,
      t.condition,
      t.publishedAt.desc(),
      t.id.desc(),
    ),
    index('listings_owner_store_status_published_at_id_idx').on(
      t.ownerType,
      t.storeId,
      t.status,
      t.publishedAt.desc(),
      t.id.desc(),
    ),
    index('listings_owner_user_status_published_at_id_idx').on(
      t.ownerType,
      t.oxyUserId,
      t.status,
      t.publishedAt.desc(),
      t.id.desc(),
    ),
    // Mongo's `{categorySlugs, status, publishedAt}` multikey. A btree cannot
    // serve `<@`/`&&`, so the element side is GIN and the rest filters on the heap.
    index('listings_category_slugs_idx').using('gin', t.categorySlugs),
    index('listings_tags_idx').using('gin', t.tags),
    index('listings_search_vector_idx').using('gin', t.searchVector),
    index('listings_geo_idx').using('gist', t.geo),
    index('listings_store_id_vendor_idx').on(t.storeId, t.vendor),
    index('listings_store_id_product_type_idx').on(t.storeId, t.productType),
    /**
     * The governance impact count's predicate, and it has a reader in the same
     * change rather than a speculative one (#61's rule).
     *
     * `services/catalog-governance/impact.service.ts` runs one `count(*)` per
     * relation `impact-plan.ts` declares — `where <reference column> = <subject
     * id>` — so the moment `listings.product_type_definition_id` joins the
     * governed-reference plan, deprecating or moving a product-type version
     * counts this table by this column. On `listings` that is the difference
     * between an index lookup and a sequential scan of the whole catalogue,
     * every time an operator asks what a publication would touch.
     *
     * PARTIAL, because the overwhelming majority of rows are legacy or connector
     * listings that carry no pin at all: a plain index would be mostly NULLs, and
     * the predicate is exactly the one every reader uses.
     */
    index('listings_product_type_definition_idx')
      .on(t.productTypeDefinitionId)
      .where(sql`${t.productTypeDefinitionId} is not null`),
    // Per-store handle uniqueness for the products that HAVE a handle. Partial
    // rather than plain: a compound `{storeId, handle}` unique would be satisfied
    // by NULL-distinctness anyway, but the partial keeps the index the size of
    // the real set and matches the `$type: 'string'` filter Mongo used.
    uniqueIndex('listings_store_id_handle_key')
      .on(t.storeId, t.handle)
      .where(sql`${t.handle} is not null`),
    // Connector upsert/lookup by provenance key, restricted to sourced listings.
    //
    // UNIQUE since #221, and the promotion is the storage catching up with what
    // the service layer already assumed: `findListingBySourceExternalId` returns
    // ONE row and every writer relies on that. Without the constraint, two
    // concurrent deliveries for one external id both read null and both create,
    // and the loser of that race is a duplicate no read will ever surface.
    // PARTIAL on the same predicate, because an unsourced listing has NULL here
    // and Postgres would treat every one of them as distinct anyway — the
    // partial keeps the index the size of the real set.
    uniqueIndex('listings_store_id_source_key_idx')
      .on(t.storeId, t.sourceConnectionId, t.sourceExternalId)
      .where(sql`${t.sourceExternalId} is not null`),
  ],
);

/**
 * `listing_images` — the gallery, one row per image.
 *
 * Embedded `{fileId, alt, position}` in Mongo. A child table rather than
 * `jsonb`: it is an ordered list of entities with a known shape, and `position`
 * is the ordering the gallery reads.
 */
export const listingImages = pgTable(
  'listing_images',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    fileId: text().notNull(),
    alt: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('listing_images_listing_id_position_idx').on(t.listingId, t.position),
    /**
     * "Does any listing already show this file?", answered per row.
     *
     * Added by #91 and read by ONE thing: the
     * `mercaria_seller_draft_reject_borrowed_photo` trigger, which fires on every
     * photograph a seller adds to a draft and is what makes "detect reused
     * canonical or merchant images" (#91 trust rule 2) true against a file id no
     * service-layer check can recognise. Without this index that trigger scans
     * every listing image in the catalogue on every upload.
     *
     * The `canonical_images` half of the same trigger is served by
     * `canonical_images_file_id_idx`, which #90 added for its own trigger.
     */
    index('listing_images_file_id_idx').on(t.fileId),
    /**
     * The composite-FK target that lets `product_variant_images` prove one of
     * its rows names an image and a variant BELONGING TO THE SAME LISTING.
     *
     * A table-level UNIQUE CONSTRAINT rather than a unique INDEX, and the
     * distinction is load-bearing: PostgreSQL resolves a composite foreign key
     * against `pg_constraint`, so a `uniqueIndex()` here type-checks, generates
     * cleanly and fails at APPLY time with "there is no unique constraint
     * matching given keys". The `listing_condition_details_id_listing_id_key`
     * precedent one file over records the same measurement.
     */
    unique('listing_images_id_listing_id_key').on(t.id, t.listingId),
  ],
);

/**
 * `listing_options` — a selectable option (`Size`) and its allowed values.
 *
 * `values` stays a `text[]`: it is a scalar list rendered as a whole, never
 * queried by element, so a row per value would be over-normalization.
 */
export const listingOptions = pgTable(
  'listing_options',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    values: text().array().notNull().default(sql`'{}'::text[]`),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('listing_options_listing_id_position_idx').on(t.listingId, t.position)],
);

/**
 * `listing_external_refs` — where a Mercaria-owned listing has been PUSHED.
 *
 * Distinct from `listings.source_*`, which is the single PULL origin: a listing
 * can be pushed to several connections, so this is many rows. It drives re-push
 * targeting and inbound-echo detection (recognising our own push coming back as
 * a webhook, so it is skipped rather than re-imported).
 */
export const listingExternalRefs = pgTable(
  'listing_external_refs',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * The connection this listing was pushed to. `cascade`: a push-mirror record
     * exists only to point at that connection and means nothing without it.
     */
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    provider: text({ enum: asEnumValues(CONNECTOR_PROVIDER_IDS) }).notNull(),
    /** The external platform's own product id — a foreign system's key. */
    externalId: text().notNull(),
    pushedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('listing_external_refs_provider_check', t.provider, CONNECTOR_PROVIDER_IDS),
    index('listing_external_refs_listing_id_idx').on(t.listingId),
    // The reverse map Mongo served with a multikey over `externalRefs`: find the
    // listing pushed to a given connection under a given external id.
    uniqueIndex('listing_external_refs_connection_id_external_id_key').on(
      t.connectionId,
      t.externalId,
    ),
  ],
);

/**
 * `product_variants` — a concrete buyable SKU of a listing.
 *
 * `price` and `compareAtPrice` are single, NATIVE-currency `Money`: the catalogue
 * stores the seller's own currency and never converts. Only TRANSACTED amounts
 * (orders, refunds) are `DualMoney`.
 *
 * The scalar `inventory.{available,committed}` is the denormalized ROLLUP over
 * this variant's `inventory_levels` rows for store variants, and the ONLY stock
 * record for P2P variants. `committed` is never exposed on the wire, but it is
 * not a protected column: it is not a secret, it is a number the DTO builder
 * omits, and putting it in the registry would make the rollup recompute — which
 * legitimately reads it — the odd one out.
 *
 * `inventory.levels` — the unused embedded array on the Mongoose model — is NOT
 * ported. `inventory_levels` is the real table and has been since B3; the
 * embedded seam was superseded before it was ever written to.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    title: text().notNull().default('Default Title'),
    /** Sparse-unique in Mongo, unique at NO grain here (#296). NULL when absent, never `''`. */
    sku: text(),
    /** Sparse-unique in Mongo, unique at NO grain here (#296). NULL when absent, never `''`. */
    barcode: text(),
    ...optionalMoney('price'),
    ...optionalMoney('compareAtPrice'),
    inventoryTracked: boolean().notNull().default(true),
    inventoryAvailable: integer().notNull().default(0),
    inventoryCommitted: integer().notNull().default(0),

    // `source` — connector provenance, flattened. Present only on synced variants.
    sourceConnectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    sourceProvider: text({ enum: asEnumValues(CONNECTOR_PROVIDER_IDS) }),
    /** The platform's own variant id. */
    sourceExternalVariantId: text(),
    /** The platform's inventory-item id — the key of an inventory-level update. */
    sourceExternalInventoryItemId: text(),

    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('product_variants_source_provider_check', t.sourceProvider, CONNECTOR_PROVIDER_IDS),
    ...currencyChecks('product_variants', [t.priceCurrency, t.compareAtPriceCurrency]),
    // Mongoose declared `price` required; it is nullable here because the two
    // columns of a `Money` are absent TOGETHER, and this CHECK is what keeps them
    // from diverging into "an amount with no currency".
    check(
      'product_variants_price_paired_check',
      sql`(${t.priceAmount} is null) = (${t.priceCurrency} is null)`,
    ),
    check(
      'product_variants_compare_at_price_paired_check',
      sql`(${t.compareAtPriceAmount} is null) = (${t.compareAtPriceCurrency} is null)`,
    ),
    index('product_variants_listing_id_position_idx').on(t.listingId, t.position),
    index('product_variants_listing_id_available_idx').on(t.listingId, t.inventoryAvailable),
    /**
     * NEITHER `sku` NOR `barcode` carries a unique index, at any scope (#296).
     *
     * Both had one — table-wide and partial — from the genesis migration, ported
     * straight from Mongo's `sparse: true, unique: true`. Both were an AMBIGUITY
     * CHECK wearing a constraint's clothes, and both were wrong about what the
     * column means.
     *
     * `barcode` is one seller's OBSERVATION of a trade-item identifier on one
     * listing, and two merchants selling one trade item share a GTIN by
     * definition — which is the premise the canonical catalogue, the offer model
     * and the whole comparison surface rest on. A table-wide unique made that
     * premise unreachable: the second merchant to list a product could not list
     * it. GTIN identity belongs to `product_identifiers`, where
     * `product_identifiers_canonical_active_key` is the collision gate and
     * answers a second claimant with `disputed` plus a review item instead of a
     * raw 23505.
     *
     * `sku` is a merchant's own code and is unique at NO grain Mercaria can
     * enforce without refusing real data. Shopify enforces no SKU uniqueness at
     * all, so one product legitimately carries two variants sharing a SKU;
     * WooCommerce enforces it site-wide. The platforms disagree and a connector
     * has to import both. It is deliberately NOT narrowed to `(listing_id, sku)`
     * either — that is exactly the shape Shopify permits, and narrowing would
     * keep half of #259's ambiguity handling permanently dead. This is the
     * ruling `product_identifiers` already records one table over for MPN: a
     * database constraint that has to be wrong sometimes is worse than one that
     * does not exist.
     *
     * What the SKU index was standing in for IS a real check, and it now lives
     * in the two places that can name what they found rather than in an index
     * that could only refuse the write: `matchIncomingVariant` (the connector
     * PULL rail) and `resolveInventoryVariant` (the push rail) both refuse to
     * pick between several candidates.
     *
     * No replacement plain index either. The one `sku` predicate in the tree is
     * `findVariantsByListingAndSku`, which leads with `listing_id` and rides
     * `product_variants_listing_id_position_idx`; `barcode` is never a predicate
     * anywhere — it is only ever selected by row id.
     */
    // Map a connector `inventory_item_id` back to its Mercaria variant for the
    // inventory pull job and the `inventory_levels/update` webhook.
    index('product_variants_source_inventory_item_idx')
      .on(t.sourceConnectionId, t.sourceExternalInventoryItemId)
      .where(sql`${t.sourceExternalInventoryItemId} is not null`),
    /**
     * ONE local variant per external variation, per connection (#259).
     *
     * This is the identity `convergeVariants` matches on, and the constraint is
     * what makes "at most one candidate" a fact rather than a hope: without it
     * the ambiguity the service refuses would simply be a state the database
     * allowed somebody to reach, and the position-matched stamping in
     * `stampVariantSources` could quietly put one platform variation on two
     * local rows — each of which then unsells the other on alternate syncs.
     *
     * The PROVIDER is deliberately not in the key. A connection determines its
     * provider (`connections.provider`), so including it would be a third
     * representation of one fact and two of the three could disagree.
     */
    uniqueIndex('product_variants_source_external_variant_key')
      .on(t.sourceConnectionId, t.sourceExternalVariantId)
      .where(sql`${t.sourceExternalVariantId} is not null`),
    /**
     * The other half of `product_variant_images`' same-listing proof. See the
     * matching constraint on `listing_images` for why this is a `unique()`
     * constraint and not a `uniqueIndex()`.
     */
    unique('product_variants_id_listing_id_key').on(t.id, t.listingId),
  ],
);

/**
 * `product_variant_images` — which of the LISTING's photographs show THIS
 * configuration (#850, epic #367).
 *
 * ## It is a SELECTION from the listing's gallery, never an upload
 *
 * The row names a `listing_images` row, not a `file_id`. That is the whole
 * design, and it is what keeps #91's ruling intact: catalogue photographs are
 * drawn from the listing's OWN gallery, because two places establishing a
 * photograph's ownership could disagree. A `file_id` column here would be a
 * second upload channel by construction — a seller could attach to a variant a
 * file that is in no gallery, and
 * `mercaria_seller_draft_reject_borrowed_photo` (which reads
 * `listing_images_file_id_idx`) would never see it. Naming the gallery row
 * instead means every variant image was already admitted and vetted as a
 * listing image; there is no second door to guard.
 *
 * It also settles the #90 collision the issue asks about: this table introduces
 * no new `file_id`, so `mercaria_reject_canonical_condition_photo` — which
 * refuses a `listing_condition_photos.file_id` that any `canonical_images` row
 * already claims — is neither weakened nor duplicated. A file that could not
 * become condition evidence still cannot; a file that reached the gallery can
 * be pointed at from here without changing who owns it.
 *
 * ## An image from ANOTHER listing is unrepresentable, not refused
 *
 * The invariant "the image and the variant belong to the same listing" is
 * cross-row, so a CHECK cannot express it (no subqueries) and a trigger would
 * be a rule a service bug walks around. Instead the row carries `listing_id`
 * and two COMPOSITE foreign keys — the `listing_condition_photos_detail_fk`
 * device — so the pair is proved by the database on every write, including one
 * made by `psql`.
 *
 * ## One image MAY be shared across variants
 *
 * `unique(variant_id, listing_image_id)` scopes uniqueness to the VARIANT,
 * which is `canonical_images_variant_ref_key`'s shape exactly. One flat-lay
 * photograph covering S/M/L is three rows, one per variant. A one-to-one
 * relation would make that ordinary case unrepresentable and force a seller to
 * upload the same photograph three times — the second upload channel again,
 * arriving through the relation shape rather than through a column.
 *
 * ## Ordering is the VARIANT's own
 *
 * `position` is per row and indexed with `variant_id`, mirroring
 * `canonical_images_variant_position_idx`. A variant's set is a different set
 * from the listing's, so there is no listing order to inherit: the seller who
 * chooses which three of eight photographs show the blue one is also choosing
 * which of the three leads.
 *
 * ## Both foreign keys CASCADE
 *
 * A selection has no meaning without either side. Deleting the variant removes
 * its selections; removing a photograph from the listing's gallery removes it
 * from every variant that showed it — the alternative is a row pointing at a
 * gallery entry a buyer can no longer see. Cascade is also the unanimous
 * convention for this parent: all twelve pre-existing foreign keys onto
 * `product_variants.id` cascade.
 */
export const productVariantImages = pgTable(
  'product_variant_images',
  {
    id: generatedId(),
    /**
     * Carried so the two composite foreign keys below can share it. It is
     * derivable from either parent, which is normally the argument against
     * storing it — here it is the mechanism: a value that must simultaneously
     * equal the variant's listing and the image's listing cannot name two.
     */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    variantId: text().notNull(),
    /** The listing gallery row this variant shows. Never a bare file id. */
    listingImageId: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'product_variant_images_variant_fk',
      columns: [t.variantId, t.listingId],
      foreignColumns: [productVariants.id, productVariants.listingId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'product_variant_images_listing_image_fk',
      columns: [t.listingImageId, t.listingId],
      foreignColumns: [listingImages.id, listingImages.listingId],
    }).onDelete('cascade'),
    // One gallery photograph appears at most once on one variant. A repeated
    // selection converges rather than doubling the gallery.
    unique('product_variant_images_variant_id_listing_image_id_key').on(
      t.variantId,
      t.listingImageId,
    ),
    // The read: one variant's images, in the seller's order.
    index('product_variant_images_variant_id_position_idx').on(t.variantId, t.position),
    // "Which variants show this photograph?" — the read a gallery removal needs
    // in order to report what it is about to change.
    index('product_variant_images_listing_image_id_idx').on(t.listingImageId),
    /**
     * `listing_id` ALONE, and it is the cascade that needs it.
     *
     * Deleting a listing makes PostgreSQL issue `DELETE FROM
     * product_variant_images WHERE listing_id = $1` for the plain foreign key
     * above. No other index here leads with the column — the two below lead
     * with `variant_id` and `listing_image_id` — so without this that RI check
     * is a sequential scan of the whole table, once per listing deleted.
     *
     * It is stated rather than left to be noticed because an index is the one
     * thing a functional test can never detect the absence of: every case in
     * `catalog.realdb.test.ts` passes either way, and the teardown that deletes
     * a store's listings is exactly the path that would degrade.
     *
     * It also serves the natural authoring read — every variant image on one
     * listing, for the screen that assigns them.
     */
    index('product_variant_images_listing_id_idx').on(t.listingId),
  ],
);

/**
 * `product_variant_option_values` — the `{name, value}` pairs that identify a
 * variant within its listing's options (`Size`/`M`).
 *
 * A child table rather than two parallel `text[]` columns: two arrays are two
 * representations of one fact and can disagree in LENGTH, which is precisely the
 * divergence a relational shape makes unrepresentable. `jsonb` was rejected for
 * the same reason it is rejected everywhere else here — the shape is known.
 */
export const productVariantOptionValues = pgTable(
  'product_variant_option_values',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    value: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('product_variant_option_values_variant_id_position_idx').on(t.variantId, t.position),
  ],
);

/**
 * `inventory_levels` — per-(variant, location) stock, the AUTHORITATIVE source
 * for a store variant.
 *
 * ## Both foreign keys CASCADE, and both fix a leak that exists today
 *
 * A level row is meaningless without either parent, which is exactly the shape
 * `CONVENTIONS.md` names for a cascade: neither `catalog-write.removeVariant`
 * nor `location.service.deleteLocation` cleans up level rows itself, and an
 * orphan is worse than a deleted row because the variant's scalar rollup keeps
 * summing stock at a place that no longer exists.
 *
 * The cascade removes the orphan; it does NOT update the denormalized total, so
 * `deleteLocation` recomputes the affected variants' rollups after it fires.
 */
export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /** Denormalized parent pointer — the level list is read by listing too. */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    locationId: text()
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    available: integer().notNull().default(0),
    committed: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The guarded reserve depends on this: one row per (variant, location), so a
    // conditional decrement is race-safe at the location grain.
    uniqueIndex('inventory_levels_variant_id_location_id_key').on(t.variantId, t.locationId),
    index('inventory_levels_location_id_available_idx').on(t.locationId, t.available),
    index('inventory_levels_listing_id_idx').on(t.listingId),
  ],
);
