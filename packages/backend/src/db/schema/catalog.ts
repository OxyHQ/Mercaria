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
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createdAt, generatedId, geography, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  ALL_LISTING_STATUSES,
  CONDITION_ASSERTIONS,
  CONNECTOR_PROVIDER_IDS,
  ITEM_CONDITION_KEYS,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
} from '@mercaria/shared-types';
import type { ItemConditionKey, ListingOwnerType } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { connections } from './connectors';
import { locations, stores } from './stores';

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
 * `categories` — the marketplace taxonomy, a tree via `parentId`.
 *
 * `ancestorSlugs` is a materialized path so a listing tagged with a leaf slug is
 * findable by any ancestor without a recursive query. It stays a `text[]`: it is
 * a scalar set queried by ELEMENT (`{ancestorSlugs: 1}` served an `$in`), which
 * is a GIN index, not a child table.
 */
export const categories = pgTable(
  'categories',
  {
    id: generatedId(),
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
    ancestorSlugs: text().array().notNull().default(sql`'{}'::text[]`),
    imageUrl: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    imageFileId: text(),
    position: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('categories_slug_key').on(t.slug),
    index('categories_parent_id_position_idx').on(t.parentId, t.position),
    index('categories_ancestor_slugs_idx').using('gin', t.ancestorSlugs),
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
    productType: text(),
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
    // Per-store handle uniqueness for the products that HAVE a handle. Partial
    // rather than plain: a compound `{storeId, handle}` unique would be satisfied
    // by NULL-distinctness anyway, but the partial keeps the index the size of
    // the real set and matches the `$type: 'string'` filter Mongo used.
    uniqueIndex('listings_store_id_handle_key')
      .on(t.storeId, t.handle)
      .where(sql`${t.handle} is not null`),
    // Connector upsert/lookup by provenance key, restricted to sourced listings.
    index('listings_store_id_source_key_idx')
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
  (t) => [index('listing_images_listing_id_position_idx').on(t.listingId, t.position)],
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
    /** Sparse-unique in Mongo. Must be written NULL when absent, never `''`. */
    sku: text(),
    /** Sparse-unique in Mongo. Must be written NULL when absent, never `''`. */
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
    uniqueIndex('product_variants_sku_key').on(t.sku).where(sql`${t.sku} is not null`),
    uniqueIndex('product_variants_barcode_key').on(t.barcode).where(sql`${t.barcode} is not null`),
    // Map a connector `inventory_item_id` back to its Mercaria variant for the
    // inventory pull job and the `inventory_levels/update` webhook.
    index('product_variants_source_inventory_item_idx')
      .on(t.sourceConnectionId, t.sourceExternalInventoryItemId)
      .where(sql`${t.sourceExternalInventoryItemId} is not null`),
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
