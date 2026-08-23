/**
 * The canonical PRODUCT layer of the commerce graph — issue #56, bound by
 * ADR 0002 D13–D16: `canonical_product_families`, `canonical_products`,
 * `canonical_variants`, their alias / source-link / redirect children,
 * `canonical_variant_attributes`, `bundle_components`, `product_identifiers`,
 * `canonical_attribute_values`, `canonical_images` and
 * `canonical_field_provenance`.
 *
 * The attribute REGISTRY (`attribute_definitions` and its satellites) lived here
 * until #94 made it versioned and moved it to `attributeRegistry.ts`. This file
 * cites those definitions through a real foreign key and declares none of its
 * own — one registry, not two.
 *
 * A FAMILY groups comparable products under a brand (iPhone). A PRODUCT is one
 * model as marketed and compared (iPhone 16 Pro). A VARIANT is one exact
 * purchasable configuration (256 GB, Black Titanium) — the ONE grain identifiers
 * bind to, offers price and native listings attach to (D5/D13). Nothing here
 * holds a price, stock or a seller: those are the listing's and the offer's, and
 * the graph attaches to them rather than absorbing them (D6).
 *
 * ## Built on #53's shared shapes (ADR 0002 D25)
 *
 * The lifecycle, alias-row and source-link-row shapes are stated ONCE in
 * `canonicalSupport.ts`. This file spreads them and adds only what a helper
 * cannot: each table's entity foreign key, its CHECKs (a CHECK needs the table
 * name), its uniques and its indexes.
 *
 * The ONE deliberate divergence is `status`: {@link catalogLifecycleColumns}
 * spreads `canonicalLifecycleColumns()` and then replaces its `status` column
 * with one typed from `CANONICAL_CATALOG_STATUSES`. A product's lifecycle
 * genuinely has two values an organization's does not (`draft`,
 * `discontinued`) and deliberately drops one it does (`inactive` — see the
 * tuple's doc comment). The override is spelled out at each table rather than
 * hidden, and the CHECK is rendered from the same tuple that types the column,
 * so the two cannot drift.
 *
 * ## What this layer does NOT contain, and why each absence is a decision
 *
 * - **No price, stock, availability or seller column anywhere.** Those are offer
 *   state (D7) and listing state (D6). A canonical row that could hold a price
 *   would immediately have two answers for what something costs.
 * - **No merchant SKU or marketplace id in `product_identifiers`.** A SKU
 *   identifies a row in one seller's system and an ASIN is Amazon's key for its
 *   own catalogue; both live on `source_records` and reach a canonical entity
 *   through the source-link tables (D14). That absence is what makes "a merchant
 *   title or SKU cannot create an accidental global identity" structural rather
 *   than a rule someone has to remember.
 * - **No `is_bundle` flag.** A bundle is a variant with `bundle_components`
 *   rows; deriving it from the rows keeps one representation of one fact.
 * - **No `manufacturer` column.** Manufacturing is an evidence-gated
 *   `commerce_relationships` row (#55, D11), not an attribute.
 * - **No jsonb.** Identifiers, dimensions, attribute values, images and
 *   provenance are all real columns or child tables (D20's jsonb boundary), so
 *   this layer adds NO row to the CONVENTIONS jsonb register.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
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
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  ATTRIBUTE_COMPONENT_AXES,
  ATTRIBUTE_NORMALIZATION_STATES,
  ATTRIBUTE_SELECTION_STATES,
  ATTRIBUTE_VERIFICATION_STATES,
  CANONICAL_ALIAS_KINDS,
  CANONICAL_CATALOG_STATUSES,
  CANONICAL_IDENTIFIER_SCHEMES,
  CANONICAL_IMAGE_STATUSES,
  CANONICAL_REDIRECT_REASONS,
  IDENTIFIER_SCHEMES,
  IDENTIFIER_STATUSES,
  SOURCE_LINK_METHODS,
  SOURCE_LINK_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import { aliasColumns, canonicalLifecycleColumns, sourceLinkColumns } from './canonicalSupport';
import { sourceRecords } from './provenance';
import { brands } from './organizations';
import { categories } from './catalog';
// The attribute REGISTRY moved to `attributeRegistry.ts` with #94, which owns
// it; this layer cites definitions rather than declaring them. Importing the
// table (instead of re-declaring one) is what keeps there being exactly one.
import { attributeDefinitions } from './attributeRegistry';

/**
 * #53's lifecycle shape with the catalogue's own `status` value set.
 *
 * Stated once here rather than at three tables, for the reason
 * `canonicalSupport.ts` exists at all: a hand-written copy of a shared shape
 * diverges silently. Each table still declares its own `checkOneOf` and its own
 * `merged_into_id` self-reference, because a CHECK and a self-FK both need the
 * table constant a column helper does not have.
 */
function catalogLifecycleColumns() {
  return {
    ...canonicalLifecycleColumns(),
    status: text({ enum: asEnumValues(CANONICAL_CATALOG_STATUSES) })
      .notNull()
      .default('active'),
  };
}

/**
 * `canonical_product_families` — a brand's product LINE (ADR 0002 D2/D13).
 *
 * `brand_id` is NULLABLE and RESTRICT: a generic line has no brand, and an
 * honest absence beats a fabricated one. A family is created only when it
 * improves navigation or matching — never because two source titles share a
 * word, which is a service rule (nothing here mints a family) pinned by test.
 *
 * `product_count` is a rollup the product write chokepoint maintains; it is
 * display state, and no decision reads it.
 */
export const canonicalProductFamilies = pgTable(
  'canonical_product_families',
  {
    id: generatedId(),
    /** URL identity, unique FOREVER — a merged tombstone keeps its slug (D12). */
    slug: text().notNull(),
    /** Canonical display name. Localized names are ALIASES, never a column. */
    name: text().notNull(),
    /** Service-maintained normalization of `name`, for candidate generation. */
    normalizedName: text().notNull(),
    /**
     * Which {@link normalizeEntityName} version folded `normalizedName` (#915).
     *
     * Not `normalization_version`: `canonical_attribute_values.normalization_rule_version`
     * is a DIFFERENT fold over different values. See `NAME_FOLD_VERSION` for what
     * a bump obliges — the fold runs on both sides, so a query folded under a
     * newer version misses a row folded under an older one SILENTLY.
     */
    nameFoldVersion: integer().notNull().default(1),
    description: text(),
    /** The brand this line is marketed under, when it has one. */
    brandId: text().references(() => brands.id, { onDelete: 'restrict' }),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    /** Rollup maintained by the product write chokepoint; nothing decides on it. */
    productCount: integer().notNull().default(0),
    /** The FINAL merge winner, flattened on write so resolution is one hop. */
    mergedIntoId: text().references((): AnyPgColumn => canonicalProductFamilies.id, {
      onDelete: 'restrict',
    }),
    ...catalogLifecycleColumns(),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${canonicalProductFamilies.name})`,
    ),
  },
  (t) => [
    checkOneOf('canonical_product_families_status_check', t.status, CANONICAL_CATALOG_STATUSES),
    check(
      'canonical_product_families_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'canonical_product_families_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('canonical_product_families_slug_key').on(t.slug),
    index('canonical_family_normalized_name_idx').on(t.normalizedName),
    index('canonical_family_normalized_name_trgm_idx').using(
      'gin',
      t.normalizedName.op('gin_trgm_ops'),
    ),
    index('canonical_family_brand_id_idx').on(t.brandId),
    index('canonical_family_search_vector_idx').using('gin', t.searchVector),
  ],
);

/** `canonical_product_family_aliases` — the D16 alias shape, for families. */
export const canonicalProductFamilyAliases = pgTable(
  'canonical_product_family_aliases',
  {
    id: generatedId(),
    familyId: text()
      .notNull()
      .references(() => canonicalProductFamilies.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('canonical_family_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('canonical_family_aliases_alias_key').on(t.familyId, t.normalizedAlias),
    index('canonical_family_aliases_alias_idx').on(t.normalizedAlias),
    index('canonical_family_aliases_alias_trgm_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/** `canonical_product_family_source_links` — the D19 source-link shape. */
export const canonicalProductFamilySourceLinks = pgTable(
  'canonical_product_family_source_links',
  {
    id: generatedId(),
    familyId: text()
      .notNull()
      .references(() => canonicalProductFamilies.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('canonical_family_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('canonical_family_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'canonical_family_source_links_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('canonical_family_source_links_active_key')
      .on(t.familyId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('canonical_family_source_links_record_idx').on(t.sourceRecordId),
  ],
);

/**
 * `canonical_product_family_redirects` — the family REDIRECT HISTORY
 * (#56 family rule 7).
 *
 * `merged_into_id` answers "where does this row point NOW". It cannot answer
 * "where did it point before", because D16's chain flattening OVERWRITES it:
 * when B merges into C, every tombstone that pointed at B is retargeted at C so
 * resolution stays one hop, and the intermediate hop is gone. This append-only
 * table is the record of each hop, which is what lets an old URL, an old export
 * or an operator reconstruct how an identity moved.
 *
 * `UNIQUE(from_id, to_id)` is the convergence key: re-running a merge writes
 * nothing (`ON CONFLICT DO NOTHING`), so the audit trail cannot grow a row per
 * retry. Both foreign keys are RESTRICT — a redirect whose target vanished is
 * not history, it is a dangling pointer.
 */
export const canonicalProductFamilyRedirects = pgTable(
  'canonical_product_family_redirects',
  {
    id: generatedId(),
    fromId: text()
      .notNull()
      .references(() => canonicalProductFamilies.id, { onDelete: 'restrict' }),
    toId: text()
      .notNull()
      .references(() => canonicalProductFamilies.id, { onDelete: 'restrict' }),
    reason: text({ enum: asEnumValues(CANONICAL_REDIRECT_REASONS) }).notNull(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    actorOxyUserId: text(),
    note: text(),
    // Append-only: no `updated_at`, the `order_status_history` contract.
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('canonical_family_redirects_reason_check', t.reason, CANONICAL_REDIRECT_REASONS),
    check('canonical_family_redirects_self_check', sql`${t.fromId} <> ${t.toId}`),
    uniqueIndex('canonical_family_redirects_from_to_key').on(t.fromId, t.toId),
    index('canonical_family_redirects_from_idx').on(t.fromId, t.createdAt),
  ],
);

/**
 * `canonical_products` — one model as marketed and compared (ADR 0002 D5/D13).
 *
 * ## Two brand paths, and which one is authoritative
 *
 * `brand_id` here is the PRODUCT's own brand; `family_id → brand_id` is the
 * LINE's. Both are required by #56 (product rule 2, family rule 2) and they can
 * legitimately differ — a co-branded model, a line that changed hands. No CHECK
 * can express cross-table agreement, so the rule is stated instead of implied:
 * **the product's own `brand_id` is the authority for identifier scoping**, and
 * a disagreement with the family's brand is review input (#59), never a silent
 * pick of one.
 *
 * ## `variant_defining_attribute_keys` is where "explicitly marked" lives
 *
 * #56 attribute rule 5 asks that variant-defining attributes be explicitly
 * marked. The fact belongs to the PRODUCT, not to an attribute definition and
 * not to a value: "storage" defines iPhone variants and describes, without
 * defining, a laptop bundled with one. So the axes are declared once per
 * product, and `canonical-variant.service` requires every variant to supply
 * exactly these keys — which is also what makes the variant signature
 * well-defined (a variant missing an axis would otherwise collide with one that
 * has it).
 *
 * The `text[]` is the `pinned_fields` precedent: a scalar set of stable KEYS,
 * not of ids, read as a whole. Keys are validated against
 * `attribute_definitions` by the write service where one exists — dimensions
 * stay free text until #94's taxonomy lands (D15).
 *
 * `rating`/`rating_count` are the product-level aggregate #56 product rule 11
 * requires, deliberately separate from `merchants.rating` (a seller's) and from
 * the native `reviews` table (a transaction's).
 */
export const canonicalProducts = pgTable(
  'canonical_products',
  {
    id: generatedId(),
    /** URL identity, unique FOREVER — a merged tombstone keeps its slug (D12). */
    slug: text().notNull(),
    /** The canonical MODEL name. A seller's title is a source fact, never this. */
    name: text().notNull(),
    /** Service-maintained normalization of `name`, for candidate generation. */
    normalizedName: text().notNull(),
    /**
     * Which {@link normalizeEntityName} version folded `normalizedName` (#915).
     *
     * Not `normalization_version`: `canonical_attribute_values.normalization_rule_version`
     * is a DIFFERENT fold over different values. See `NAME_FOLD_VERSION` for what
     * a bump obliges — the fold runs on both sides, so a query folded under a
     * newer version misses a row folded under an older one SILENTLY.
     */
    nameFoldVersion: integer().notNull().default(1),
    description: text(),
    /** The product's own brand — the authority for identifier scoping. */
    brandId: text().references(() => brands.id, { onDelete: 'restrict' }),
    familyId: text().references(() => canonicalProductFamilies.id, { onDelete: 'restrict' }),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    /** Release/model metadata, written only when RELIABLY known — never inferred. */
    releasedAt: timestamptz(),
    discontinuedAt: timestamptz(),
    modelYear: integer(),
    modelCode: text(),
    /** Normalized search tokens; the write chokepoint maintains them. */
    searchTokens: text().array().notNull().default(sql`'{}'::text[]`),
    /** The declared option axes of this product's variants. See the doc above. */
    variantDefiningAttributeKeys: text().array().notNull().default(sql`'{}'::text[]`),
    /** Product-level rating — NOT the merchant's and NOT a transaction review's. */
    rating: doublePrecision().notNull().default(0),
    ratingCount: integer().notNull().default(0),
    /** Rollup maintained by the variant write chokepoint. */
    variantCount: integer().notNull().default(0),
    mergedIntoId: text().references((): AnyPgColumn => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    ...catalogLifecycleColumns(),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${canonicalProducts.name})`,
    ),
  },
  (t) => [
    checkOneOf('canonical_products_status_check', t.status, CANONICAL_CATALOG_STATUSES),
    check(
      'canonical_products_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'canonical_products_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    check(
      'canonical_products_model_year_check',
      sql`${t.modelYear} is null or (${t.modelYear} >= 1800 and ${t.modelYear} <= 2200)`,
    ),
    check(
      'canonical_products_rating_check',
      sql`${t.rating} >= 0 and ${t.rating} <= 5 and ${t.ratingCount} >= 0`,
    ),
    uniqueIndex('canonical_products_slug_key').on(t.slug),
    index('canonical_products_normalized_name_idx').on(t.normalizedName),
    index('canonical_products_normalized_name_trgm_idx').using(
      'gin',
      t.normalizedName.op('gin_trgm_ops'),
    ),
    /**
     * #61 — the trigram index the candidate search ORDERS on.
     *
     * GiST beside the GIN above, and the two are not redundant spellings of one
     * index: GIN serves the `%` CONTAINMENT filter and cannot serve a
     * distance ORDER BY at all, so `searchCanonicalProductsByNameSimilarity`
     * had to fetch every row above the similarity threshold and top-N sort it.
     * GiST supports the `<->` distance operator as a real index scan, which is
     * why that reader now spells its ordering `normalized_name <-> $1` — and
     * that respelling is what makes this index usable rather than decorative.
     *
     * Measured on the seeded `medium` scale (100,000 products, one brand
     * carrying 17,945 of them): **87.1 ms → 13.1 ms**, and the rows the
     * executor touches drop from **32,476 to 25** — the plan becomes one index
     * scan carrying BOTH `Index Cond: normalized_name % $1` and
     * `Order By: normalized_name <-> $1`, with no Sort node. Index size is 13 MB
     * against the GIN's 12 MB on a 34 MB table.
     *
     * The GIN index is deliberately KEPT. The KNN plan measured above does not
     * touch it, which makes it a candidate for removal — but "the planner did
     * not choose it in this query at this scale" is not "no query at any scale
     * needs it", and #61's own rule is not to change what it did not measure.
     * That measurement, and the drop if it holds, belong to a follow-up.
     */
    index('canonical_products_normalized_name_gist_trgm_idx').using(
      'gist',
      t.normalizedName.op('gist_trgm_ops'),
    ),
    index('canonical_products_brand_id_idx').on(t.brandId),
    /**
     * #61 — the brand page, which is the read that amplified worst of all.
     *
     * `listProductsForBrand` filters on `brand_id`, excludes tombstones and
     * orders by `(name, id)` with a LIMIT. `canonical_products_brand_id_idx`
     * serves only the equality, so the sort became a top-N heapsort over EVERY
     * product of that brand — and a big brand is exactly the page a person
     * opens. Carrying the sort columns turns it into an ordered index scan that
     * stops at the limit.
     *
     * Measured on the seeded `medium` scale, brand carrying 17,945 products:
     * **5.011 ms → 0.097 ms**, rows scanned **17,945 → 20**. Index size 7.2 MB.
     *
     * Partial on `status <> 'merged'`, matching the reader's own predicate, so
     * the index does not carry tombstones no page will ever show.
     */
    index('canonical_products_brand_page_idx')
      .on(t.brandId, t.name, t.id)
      .where(sql`${t.status} <> 'merged'`),
    index('canonical_products_family_id_idx').on(t.familyId),
    index('canonical_products_category_id_idx').on(t.categoryId),
    index('canonical_products_search_tokens_idx').using('gin', t.searchTokens),
    index('canonical_products_search_vector_idx').using('gin', t.searchVector),
    index('canonical_products_status_created_at_idx').on(t.status, t.createdAt.desc()),
  ],
);

/** `canonical_product_aliases` — the D16 alias shape, for products. */
export const canonicalProductAliases = pgTable(
  'canonical_product_aliases',
  {
    id: generatedId(),
    productId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('canonical_product_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('canonical_product_aliases_alias_key').on(t.productId, t.normalizedAlias),
    index('canonical_product_aliases_alias_idx').on(t.normalizedAlias),
    index('canonical_product_aliases_alias_trgm_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/** `canonical_product_source_links` — the D19 source-link shape, for products. */
export const canonicalProductSourceLinks = pgTable(
  'canonical_product_source_links',
  {
    id: generatedId(),
    productId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('canonical_product_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('canonical_product_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'canonical_product_source_links_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('canonical_product_source_links_active_key')
      .on(t.productId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('canonical_product_source_links_record_idx').on(t.sourceRecordId),
  ],
);

/** `canonical_product_redirects` — see `canonical_product_family_redirects`. */
export const canonicalProductRedirects = pgTable(
  'canonical_product_redirects',
  {
    id: generatedId(),
    fromId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    toId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    reason: text({ enum: asEnumValues(CANONICAL_REDIRECT_REASONS) }).notNull(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    actorOxyUserId: text(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('canonical_product_redirects_reason_check', t.reason, CANONICAL_REDIRECT_REASONS),
    check('canonical_product_redirects_self_check', sql`${t.fromId} <> ${t.toId}`),
    uniqueIndex('canonical_product_redirects_from_to_key').on(t.fromId, t.toId),
    index('canonical_product_redirects_from_idx').on(t.fromId, t.createdAt),
  ],
);

/**
 * `canonical_variants` — one exact purchasable configuration (ADR 0002 D5/D13).
 *
 * ## The signature, and the constraint that makes it worth computing
 *
 * `signature` is a digest of this variant's option assignments, computed over
 * the assignments SORTED by attribute key with each value in its normalized
 * form — so "Colour: Black, Storage: 256 GB" and "Storage: 256GB, Colour:
 * Black" produce the SAME signature (#56 variant rule 6). `position` is display
 * order and is deliberately not an input.
 *
 * `UNIQUE(product_id, signature)` is what makes that determinism load-bearing
 * rather than decorative: two variants of one product cannot carry the same
 * option assignments, whichever order a source listed them in, and the second
 * write is refused by the database rather than by whoever remembered to check.
 * It is also why every product's DEFAULT variant is exactly one row — the empty
 * assignment set has one signature.
 *
 * The column is maintained by `canonical-variant.service`, the ONE writer, in
 * the same transaction as any attribute change. It is NOT a generated column: a
 * generated expression cannot read another table, and pretending otherwise
 * would put a digest of nothing in a unique index.
 *
 * `is_default` is separate and honest: a default variant exists only where the
 * concept is meaningful (#56 variant rule 7), and the partial unique holds at
 * most one per product.
 */
export const canonicalVariants = pgTable(
  'canonical_variants',
  {
    id: generatedId(),
    productId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** Display name of the configuration — "256 GB, Black Titanium". */
    name: text(),
    /** The order-independent digest of the option assignments. See above. */
    signature: text().notNull(),
    isDefault: boolean().notNull().default(false),
    releasedAt: timestamptz(),
    discontinuedAt: timestamptz(),
    mergedIntoId: text().references((): AnyPgColumn => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    ...catalogLifecycleColumns(),
  },
  (t) => [
    checkOneOf('canonical_variants_status_check', t.status, CANONICAL_CATALOG_STATUSES),
    check(
      'canonical_variants_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'canonical_variants_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    // A signature that is not a sha-256 hex digest is not one this codebase
    // produced, and it would silently weaken the uniqueness below.
    check('canonical_variants_signature_shape_check', sql`${t.signature} ~ '^[0-9a-f]{64}$'`),
    // THE order-independence gate (#56 variant rule 6, acceptance 6).
    uniqueIndex('canonical_variants_product_signature_key').on(t.productId, t.signature),
    uniqueIndex('canonical_variants_product_default_key')
      .on(t.productId)
      .where(sql`${t.isDefault}`),
    index('canonical_variants_product_id_idx').on(t.productId),
    index('canonical_variants_status_idx').on(t.status, t.createdAt.desc()),
  ],
);

/** `canonical_variant_aliases` — the D16 alias shape, for variants. */
export const canonicalVariantAliases = pgTable(
  'canonical_variant_aliases',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('canonical_variant_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('canonical_variant_aliases_alias_key').on(t.variantId, t.normalizedAlias),
    index('canonical_variant_aliases_alias_idx').on(t.normalizedAlias),
    index('canonical_variant_aliases_alias_trgm_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/** `canonical_variant_source_links` — the D19 source-link shape, for variants. */
export const canonicalVariantSourceLinks = pgTable(
  'canonical_variant_source_links',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('canonical_variant_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('canonical_variant_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'canonical_variant_source_links_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('canonical_variant_source_links_active_key')
      .on(t.variantId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('canonical_variant_source_links_record_idx').on(t.sourceRecordId),
  ],
);

/**
 * `canonical_variant_attributes` — the option assignments that DEFINE a variant
 * (ADR 0002 D15's `{variant_id, dimension, value, position}`, with the
 * normalization #56 attribute rules 2–4 require).
 *
 * Membership in this table IS the "variant-defining" marking at the row grain;
 * the product declares the axis list. Three value columns, three different
 * jobs, none substituting for another:
 *
 * - `display_value` — the source's own words, preserved verbatim.
 * - `normalized_value` — what the signature is computed over. A quantity's
 *   normalized form is its base-unit magnitude, so "256 GB" and "0.256 TB"
 *   collapse to one variant instead of two.
 * - `normalized_number` + `normalized_unit` — the parsed quantity, present only
 *   when `normalization_state` is `normalized`.
 *
 * The state CHECK is the structural form of "unknown or conflicting values
 * remain source facts and are not guessed": an unparsed dimension carries no
 * parsed magnitude at all.
 */
export const canonicalVariantAttributes = pgTable(
  'canonical_variant_attributes',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    /** The registry entry, when the key is a defined attribute. */
    attributeDefinitionId: text().references(() => attributeDefinitions.id, {
      onDelete: 'restrict',
    }),
    /**
     * The registry version this axis was normalized under (#94). NULL when the
     * key is not in the registry at all, which stays legal: a source may name an
     * axis nobody has defined yet, and refusing it would lose the variant.
     */
    definitionVersion: integer(),
    /** The normalized dimension key — `storage`, `color`, `pack_count`, `region`. */
    attributeKey: text().notNull(),
    /** The source's own words. */
    displayValue: text().notNull(),
    /** The signature input. Lowercased, or a base-unit magnitude for a quantity. */
    normalizedValue: text().notNull(),
    normalizedNumber: doublePrecision(),
    normalizedUnit: text(),
    normalizationState: text({ enum: asEnumValues(ATTRIBUTE_NORMALIZATION_STATES) })
      .notNull()
      .default('normalized'),
    /** DISPLAY order only — deliberately not an input to the signature. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'canonical_variant_attrs_state_check',
      t.normalizationState,
      ATTRIBUTE_NORMALIZATION_STATES,
    ),
    check(
      'canonical_variant_attrs_key_shape_check',
      sql`${t.attributeKey} = lower(btrim(${t.attributeKey})) and ${t.attributeKey} <> ''`,
    ),
    // Nothing but a normalized row may carry a parsed magnitude.
    check(
      'canonical_variant_attrs_parsed_check',
      sql`${t.normalizationState} = 'normalized' or (${t.normalizedNumber} is null and ${t.normalizedUnit} is null)`,
    ),
    // A unit with no magnitude measures nothing.
    check(
      'canonical_variant_attrs_unit_check',
      sql`${t.normalizedUnit} is null or ${t.normalizedNumber} is not null`,
    ),
    // A version without a definition names nothing; a definition without a
    // version cannot be reproduced. They travel together (#94 value rule 2).
    check(
      'canonical_variant_attrs_definition_version_check',
      sql`(${t.attributeDefinitionId} is null) = (${t.definitionVersion} is null)`,
    ),
    // One value per axis per variant: a variant with two storages is not a
    // variant, and the signature would depend on which row won.
    uniqueIndex('canonical_variant_attrs_key_unique').on(t.variantId, t.attributeKey),
    // Reverse lookup: which variants are 256 GB?
    index('canonical_variant_attrs_value_idx').on(t.attributeKey, t.normalizedValue),
  ],
);

/**
 * `canonical_images` — canonical imagery at the product OR variant grain
 * (#56 product rule 7, variant rule 4).
 *
 * `source_record_id` is **NOT NULL**, which is the whole design: an image with
 * no observation behind it cannot be written, so "every image is traceable to
 * provenance" (#56 acceptance 4) is structural rather than a habit. Operator
 * uploads are not an exception — operator entry IS a `catalog_sources` row
 * (D19), so there is no "no source" case to carve out.
 *
 * There is deliberately NO per-image rights column. Rights are properties of
 * the agreement with the SOURCE (`may_display`, `attribution_required`), read
 * off this record's source registry row; a copy here would be a second
 * representation of a fact the registry owns, and the two could disagree about
 * whether an image may be shown.
 *
 * `image_ref` is GENERATED from `coalesce(file_id, source_url)` — both
 * IMMUTABLE — so the convergence unique cannot be dodged by whichever of the
 * two a caller happened to fill.
 */
export const canonicalImages = pgTable(
  'canonical_images',
  {
    id: generatedId(),
    productId: text().references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    variantId: text().references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    fileId: text(),
    /** The image's address at its source, when Mercaria holds no copy of it. */
    sourceUrl: text(),
    /** The convergence key: whichever address this image actually has. */
    imageRef: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce("file_id", "source_url")`),
    /**
     * The observation that supplied this image. RESTRICT and NOT NULL — see the
     * doc comment: provenance is the precondition, not an annotation.
     */
    sourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    alt: text(),
    /** BCP-47 tag when the asset is locale-specific (a localized box shot). */
    locale: text(),
    position: integer().notNull().default(0),
    status: text({ enum: asEnumValues(CANONICAL_IMAGE_STATUSES) }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('canonical_images_status_check', t.status, CANONICAL_IMAGE_STATUSES),
    // Exactly one grain — the `product_identifiers` shape, for the same reason:
    // an image of "the product and also this one variant" is two facts.
    check(
      'canonical_images_grain_check',
      sql`(${t.productId} is not null)::int + (${t.variantId} is not null)::int = 1`,
    ),
    check(
      'canonical_images_address_check',
      sql`${t.fileId} is not null or ${t.sourceUrl} is not null`,
    ),
    uniqueIndex('canonical_images_product_ref_key')
      .on(t.productId, t.imageRef)
      .where(sql`${t.productId} is not null`),
    uniqueIndex('canonical_images_variant_ref_key')
      .on(t.variantId, t.imageRef)
      .where(sql`${t.variantId} is not null`),
    index('canonical_images_product_position_idx').on(t.productId, t.position),
    index('canonical_images_variant_position_idx').on(t.variantId, t.position),
    index('canonical_images_source_record_idx').on(t.sourceRecordId),
    /**
     * "Is this file id a catalogue image?", answered per row.
     *
     * Added by #90 and read by ONE thing: the
     * `mercaria_reject_canonical_condition_photo` trigger, which fires on every
     * insert into `listing_condition_photos` and is what makes "canonical
     * images never satisfy native used-item photo requirements" (#90 acceptance
     * 4) true against a seller who attaches the manufacturer's own product
     * shot. Without this index that trigger is a sequential scan of the whole
     * canonical image set on every photograph a seller uploads.
     *
     * PARTIAL, because a source-hosted image has no `file_id` and can never
     * collide with an Oxy media id.
     */
    index('canonical_images_file_id_idx').on(t.fileId).where(sql`${t.fileId} is not null`),
  ],
);

/**
 * `canonical_attribute_values` — typed, normalized attribute FACTS at the
 * product or variant grain (#56 attribute rules 2–4).
 *
 * Distinct from `canonical_variant_attributes`, which holds only the axes that
 * DEFINE a variant. This table holds everything else a source says about a
 * thing — screen size, weight, material — and it holds it as a SOURCE FACT, one
 * row per (entity, key, observation).
 *
 * That is why there is a `selection_state` rather than one row per key: when two
 * sources disagree, BOTH rows survive, neither is selected, and both are marked
 * `conflicting`. The partial uniques hold at most one SELECTED value per
 * attribute SLOT, so a read surface has exactly one answer per slot while the
 * disagreement stays visible for review. Guessing a winner is not available —
 * there is no code path that writes a value no source asserted.
 *
 * ## What #94 added, and why each column is not derivable
 *
 * - `definition_version` + `normalization_rule_version` — an evaluation must be
 *   able to say which rules produced a number. Without them, changing what an
 *   attribute means silently reinterprets every value recorded under the old
 *   meaning instead of scheduling a re-normalization.
 * - `source_unit` — the unit the source WROTE, kept beside the converted one, so
 *   "6.1 in" is still recoverable from a row storing 154.94 mm. Reversibility
 *   for display is a requirement, and a conversion that discards its input is
 *   not reversible.
 * - `normalized_number_max` + the two inclusivity flags — a range is one value,
 *   and its strictness is part of it (#94 normalization rule 6).
 * - `component_axis` + `position` (through the generated `value_slot`) — a
 *   dimensions observation is three facts with named axes, not one string whose
 *   axis order a reader guesses (rule 7).
 * - `normalized_amount_minor` + `normalized_currency` — currency stays in the
 *   `Money` domain rather than becoming a generic decimal (rule 9).
 * - `verification_state` — corroboration by a second independent source is a
 *   fact about the WORLD; `confidence` is one source's estimate of itself. A
 *   number cannot stand in for the other.
 */
export const canonicalAttributeValues = pgTable(
  'canonical_attribute_values',
  {
    id: generatedId(),
    productId: text().references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    variantId: text().references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    attributeDefinitionId: text().references(() => attributeDefinitions.id, {
      onDelete: 'restrict',
    }),
    /** The registry version this value was normalized under (#94 value rule 2). */
    definitionVersion: integer(),
    attributeKey: text().notNull(),
    /** The source's own words, verbatim — never normalized away. */
    sourceDisplayValue: text().notNull(),
    /** The unit the source wrote, before conversion (#94 value rule 5). */
    sourceUnit: text(),
    normalizedText: text(),
    normalizedNumber: doublePrecision(),
    /** The UPPER bound of a `range` value; `normalized_number` is the lower one. */
    normalizedNumberMax: doublePrecision(),
    /** Range strictness, per end (#94 normalization rule 6). Both travel with the max. */
    rangeLowerInclusive: boolean(),
    rangeUpperInclusive: boolean(),
    normalizedUnit: text(),
    normalizedBoolean: boolean(),
    normalizedDate: timestamptz(),
    /**
     * A `money`-typed value, in minor units. A bare `bigint` rather than a
     * `money()` pair, the `fee_schedules` min/max rule: the currency is the
     * DEFINITION's one pinned currency, so a second currency column here would
     * be a second representation of it — and the two could disagree. The
     * `normalized_currency` column beside it exists ONLY to keep the row
     * self-describing for a value whose definition has since been superseded.
     */
    normalizedAmountMinor: bigint({ mode: 'number' }),
    normalizedCurrency: text({ enum: CURRENCY_CODE_VALUES }),
    /** The named component of a `structured` value — an explicit axis, never a guess. */
    componentAxis: text({ enum: asEnumValues(ATTRIBUTE_COMPONENT_AXES) }),
    /** Position within a `set` or `ordered_list`; 0 for a single value. */
    position: integer().notNull().default(0),
    /**
     * The convergence and selection SLOT.
     *
     * GENERATED because a plain multi-column unique over a nullable
     * `component_axis` would NOT work: Postgres treats NULLs as distinct, so two
     * axis-less rows for one key and one source record would both be admitted —
     * exactly the duplicate the unique exists to refuse. Collapsing the pair into
     * one text value is the `commerce_relationships.endpoint_key` device, and
     * both functions in it are IMMUTABLE.
     */
    valueSlot: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce("component_axis", '') || '#' || "position"::text`),
    normalizationState: text({ enum: asEnumValues(ATTRIBUTE_NORMALIZATION_STATES) }).notNull(),
    /** Whether this is the value Mercaria shows, and if not, why not. */
    selectionState: text({ enum: asEnumValues(ATTRIBUTE_SELECTION_STATES) })
      .notNull()
      .default('candidate'),
    /** How much INDEPENDENT backing this fact has — not the same as `confidence`. */
    verificationState: text({ enum: asEnumValues(ATTRIBUTE_VERIFICATION_STATES) })
      .notNull()
      .default('unverified'),
    /** BCP-47 tag when the value is locale-specific (a localized colour name). */
    locale: text(),
    /** The observation this fact came from. NOT NULL — same rule as images. */
    sourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** When the source observed it. Distinct from when Mercaria wrote the row. */
    observedAt: timestamptz(),
    /** How the value was attached — the `SOURCE_LINK_METHODS` vocabulary, reused. */
    method: text({ enum: asEnumValues(SOURCE_LINK_METHODS) }).notNull().default('connector_declared'),
    /** The normalization ruleset that produced the columns above (#94 value rule 10). */
    normalizationRuleVersion: text().notNull().default('nr-1'),
    /** 0–1; NULL for a deterministic or human assertion, which outranks numbers. */
    confidence: doublePrecision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'canonical_attribute_values_state_check',
      t.normalizationState,
      ATTRIBUTE_NORMALIZATION_STATES,
    ),
    checkOneOf(
      'canonical_attribute_values_selection_check',
      t.selectionState,
      ATTRIBUTE_SELECTION_STATES,
    ),
    checkOneOf(
      'canonical_attribute_values_verification_check',
      t.verificationState,
      ATTRIBUTE_VERIFICATION_STATES,
    ),
    checkOneOf('canonical_attribute_values_axis_check', t.componentAxis, ATTRIBUTE_COMPONENT_AXES),
    checkOneOf('canonical_attribute_values_method_check', t.method, SOURCE_LINK_METHODS),
    ...currencyChecks('canonical_attribute_values', [t.normalizedCurrency]),
    check(
      'canonical_attribute_values_grain_check',
      sql`(${t.productId} is not null)::int + (${t.variantId} is not null)::int = 1`,
    ),
    check(
      'canonical_attribute_values_key_shape_check',
      sql`${t.attributeKey} = lower(btrim(${t.attributeKey})) and ${t.attributeKey} <> ''`,
    ),
    check(
      'canonical_attribute_values_definition_version_check',
      sql`(${t.attributeDefinitionId} is null) = (${t.definitionVersion} is null)`,
    ),
    // "Never guessed", structurally: only a normalized row carries a normalized
    // value of any kind. Every typed column is inside the same refusal, so
    // widening the value types cannot leave one of them outside it.
    check(
      'canonical_attribute_values_parsed_check',
      sql`${t.normalizationState} = 'normalized' or (
        ${t.normalizedText} is null and ${t.normalizedNumber} is null
        and ${t.normalizedNumberMax} is null and ${t.normalizedUnit} is null
        and ${t.normalizedBoolean} is null and ${t.normalizedDate} is null
        and ${t.normalizedAmountMinor} is null and ${t.normalizedCurrency} is null
      )`,
    ),
    check(
      'canonical_attribute_values_unit_check',
      sql`${t.normalizedUnit} is null or ${t.normalizedNumber} is not null`,
    ),
    // A range is a lower bound, an upper bound and two strictnesses, or it is
    // not a range. A half-filled interval compares wrongly rather than failing.
    check(
      'canonical_attribute_values_range_check',
      sql`num_nonnulls(${t.normalizedNumberMax}, ${t.rangeLowerInclusive}, ${t.rangeUpperInclusive}) in (0, 3)`,
    ),
    check(
      'canonical_attribute_values_range_lower_check',
      sql`${t.normalizedNumberMax} is null or (${t.normalizedNumber} is not null and ${t.normalizedNumber} <= ${t.normalizedNumberMax})`,
    ),
    // A `Money` is present in both columns or in neither (`fee_schedules`).
    check(
      'canonical_attribute_values_money_check',
      sql`num_nonnulls(${t.normalizedAmountMinor}, ${t.normalizedCurrency}) in (0, 2)`,
    ),
    check('canonical_attribute_values_position_check', sql`${t.position} >= 0`),
    // Only a NORMALIZED value may be the one shown. A row that could not be read
    // is unshowable by construction, not by a filter somebody remembered.
    check(
      'canonical_attribute_values_selected_state_check',
      sql`${t.selectionState} <> 'selected' or ${t.normalizationState} = 'normalized'`,
    ),
    check(
      'canonical_attribute_values_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    // Convergence: re-applying one observation is a no-op, per grain and per
    // slot — a dimensions observation legitimately writes three rows.
    uniqueIndex('canonical_attribute_values_product_key')
      .on(t.productId, t.attributeKey, t.sourceRecordId, t.valueSlot)
      .where(sql`${t.productId} is not null`),
    uniqueIndex('canonical_attribute_values_variant_key')
      .on(t.variantId, t.attributeKey, t.sourceRecordId, t.valueSlot)
      .where(sql`${t.variantId} is not null`),
    // One SELECTED value per attribute SLOT per entity — the read surface's
    // answer. Slot-scoped rather than key-scoped so a `set` attribute can show
    // three ports while a `single` one still shows exactly one value.
    uniqueIndex('canonical_attribute_values_product_selected_key')
      .on(t.productId, t.attributeKey, t.valueSlot)
      .where(sql`${t.selectionState} = 'selected' and ${t.productId} is not null`),
    uniqueIndex('canonical_attribute_values_variant_selected_key')
      .on(t.variantId, t.attributeKey, t.valueSlot)
      .where(sql`${t.selectionState} = 'selected' and ${t.variantId} is not null`),
    index('canonical_attribute_values_key_idx').on(t.attributeKey, t.normalizedText),
    // The range scan every numeric filter and facet runs.
    index('canonical_attribute_values_numeric_idx')
      .on(t.attributeKey, t.normalizedNumber)
      .where(sql`${t.selectionState} = 'selected'`),
    index('canonical_attribute_values_record_idx').on(t.sourceRecordId),
    index('canonical_attribute_values_review_idx')
      .on(t.attributeKey, t.selectionState)
      .where(sql`${t.selectionState} = 'conflicting'`),
  ],
);

/**
 * `canonical_field_provenance` — where each SELECTED canonical field came from
 * (#56 family rule 7, product rule 10, acceptance 4).
 *
 * This is #53's provenance layer read at field grain, NOT a second one: the
 * observation is a real `source_records` foreign key, `method` is the same
 * `SOURCE_LINK_METHODS` tuple a source link uses, and `confidence` carries the
 * identical semantics — NULL means a deterministic or human decision and
 * outranks every number, which is what lets "a lower-confidence source never
 * overwrites" be decided by comparing two rows of the same shape.
 *
 * Three nullable entity foreign keys plus a CHECK, not a polymorphic
 * `{kind, id}` pair: every endpoint's key space is in THIS database, so real
 * foreign keys are available — the `commerce_relationships` reasoning (D17),
 * and the reason nothing here needs a ledger entry for an unconstrained id.
 */
export const canonicalFieldProvenance = pgTable(
  'canonical_field_provenance',
  {
    id: generatedId(),
    familyId: text().references(() => canonicalProductFamilies.id, { onDelete: 'cascade' }),
    productId: text().references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    variantId: text().references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    /** The canonical column this row explains, by its TypeScript property name. */
    field: text().notNull(),
    sourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    method: text({ enum: asEnumValues(SOURCE_LINK_METHODS) }).notNull(),
    /** 0–1; NULL for a deterministic or human decision — the strongest reading. */
    confidence: doublePrecision(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    decidedByOxyUserId: text(),
    selectedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('canonical_field_provenance_method_check', t.method, SOURCE_LINK_METHODS),
    check(
      'canonical_field_provenance_grain_check',
      sql`(${t.familyId} is not null)::int + (${t.productId} is not null)::int + (${t.variantId} is not null)::int = 1`,
    ),
    check(
      'canonical_field_provenance_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('canonical_field_provenance_family_key')
      .on(t.familyId, t.field)
      .where(sql`${t.familyId} is not null`),
    uniqueIndex('canonical_field_provenance_product_key')
      .on(t.productId, t.field)
      .where(sql`${t.productId} is not null`),
    uniqueIndex('canonical_field_provenance_variant_key')
      .on(t.variantId, t.field)
      .where(sql`${t.variantId} is not null`),
    index('canonical_field_provenance_record_idx').on(t.sourceRecordId),
  ],
);

/**
 * `bundle_components` — a bundle variant and the variants it contains
 * (ADR 0002 D15).
 *
 * A bundle (console + game) is its OWN product because it is bought, priced and
 * identified as one thing, often with its own GTIN. Its components are recorded
 * so comparison can decompose it. `component_variant_id` is RESTRICT: a variant
 * referenced by a bundle cannot vanish — the bundle would then claim to contain
 * something with no identity.
 */
export const bundleComponents = pgTable(
  'bundle_components',
  {
    id: generatedId(),
    bundleVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    componentVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    quantity: integer().notNull().default(1),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('bundle_components_quantity_check', sql`${t.quantity} > 0`),
    check('bundle_components_self_check', sql`${t.bundleVariantId} <> ${t.componentVariantId}`),
    uniqueIndex('bundle_components_pair_key').on(t.bundleVariantId, t.componentVariantId),
    index('bundle_components_component_idx').on(t.componentVariantId),
  ],
);

/**
 * `product_identifiers` — one externally minted identifier ASSERTION
 * (ADR 0002 D14).
 *
 * ## The grain is the scheme's, not the caller's
 *
 * `product_id` and `variant_id` are nullable with a CHECK that exactly one is
 * set. The GTIN family and MPN identify a trade item and bind to a VARIANT;
 * `brand_model` names a model and binds to a PRODUCT. The service refuses a
 * scheme written at the wrong grain, reading the bound registry
 * (`IDENTIFIER_SCHEME_REGISTRY`) rather than a rule retyped here.
 *
 * ## Three uniqueness decisions, each with a different reason
 *
 * 1. `(canonical_scheme, canonical_value) WHERE status='active'` — ONE active
 *    canonical owner per GTIN. This is the collision gate: a second entity
 *    asserting an owned GTIN is written `disputed` and routed to review, and the
 *    newcomer never steals the identifier (#56 acceptance 3).
 * 2. `(variant_id, scheme, normalized_value) WHERE status='active'` and its
 *    product-grain twin — re-observing the same identifier for the same entity
 *    converges instead of accumulating duplicate active assignments (#56 API
 *    rule 3).
 * 3. **No uniqueness at all for MPN and `brand_model`.** MPNs collide across
 *    brands legitimately, so a constraint would refuse real data; brand
 *    agreement is a cross-table fact the matcher checks and the service routes
 *    to review (D14). A database constraint that has to be wrong sometimes is
 *    worse than one that does not exist.
 *
 * ## Corrections append, and the values never move
 *
 * `raw_value`, `normalized_value`, `scheme` and the canonical pair are IMMUTABLE
 * after insert, enforced by the `product_identifiers_values_immutable` trigger —
 * not by a convention, because a backfill script and an operator at a `psql`
 * prompt both reach this table without the service. Fixing a wrong identifier
 * retires the old row (`status='corrected'`) and inserts a new one naming it
 * through `supersedes_identifier_id`. That pointer runs BACKWARDS in time — the
 * successor names its predecessor — so it always resolves, the direction the
 * referral domain measured the hard way.
 *
 * The trigger permits exactly two updates, and both are deliberate: a STATUS
 * transition, because that is how a correction is recorded; and an OWNER change,
 * because D16's merge repoints the loser's identifiers onto the winner, and an
 * identifier that could not change owner would make a merge either destroy that
 * history or fail outright.
 */
export const productIdentifiers = pgTable(
  'product_identifiers',
  {
    id: generatedId(),
    productId: text().references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    variantId: text().references(() => canonicalVariants.id, { onDelete: 'cascade' }),
    scheme: text({ enum: asEnumValues(IDENTIFIER_SCHEMES) }).notNull(),
    /** Exactly what the source said. Immutable after insert (trigger). */
    rawValue: text().notNull(),
    /** The scheme's own normalization — digits for a GTIN, folded case for an MPN. */
    normalizedValue: text().notNull(),
    /** The cross-scheme normalization, when the scheme has one (`gtin` today). */
    canonicalScheme: text({ enum: asEnumValues(CANONICAL_IDENTIFIER_SCHEMES) }),
    /** Zero-padded GTIN-14 digits, check digit validated. Immutable after insert. */
    canonicalValue: text(),
    status: text({ enum: asEnumValues(IDENTIFIER_STATUSES) }).notNull().default('active'),
    /** The active row this assertion collides with. Present exactly when disputed. */
    conflictsWithIdentifierId: text().references((): AnyPgColumn => productIdentifiers.id, {
      onDelete: 'restrict',
    }),
    /** The row this one corrects. Backwards in time, so it always resolves. */
    supersedesIdentifierId: text().references((): AnyPgColumn => productIdentifiers.id, {
      onDelete: 'restrict',
    }),
    /** The observation that asserted it, when it came from one rather than a person. */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    assignedByOxyUserId: text(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('product_identifiers_scheme_check', t.scheme, IDENTIFIER_SCHEMES),
    checkOneOf('product_identifiers_status_check', t.status, IDENTIFIER_STATUSES),
    checkOneOf(
      'product_identifiers_canonical_scheme_check',
      t.canonicalScheme,
      CANONICAL_IDENTIFIER_SCHEMES,
    ),
    check(
      'product_identifiers_grain_check',
      sql`(${t.productId} is not null)::int + (${t.variantId} is not null)::int = 1`,
    ),
    // The canonical pair travels together or not at all: half of it is a value
    // the collision gate would index against a scheme nobody declared.
    check(
      'product_identifiers_canonical_pair_check',
      sql`(${t.canonicalScheme} is null) = (${t.canonicalValue} is null)`,
    ),
    // A GTIN that is not 14 digits is not a GTIN-14, and it would sit in the
    // uniqueness gate colliding with nothing.
    check(
      'product_identifiers_canonical_value_shape_check',
      sql`${t.canonicalValue} is null or ${t.canonicalValue} ~ '^[0-9]{14}$'`,
    ),
    // A dispute that cannot name what it disputes is not reviewable.
    check(
      'product_identifiers_dispute_check',
      sql`(${t.status} = 'disputed') = (${t.conflictsWithIdentifierId} is not null)`,
    ),
    check('product_identifiers_normalized_value_check', sql`${t.normalizedValue} <> ''`),
    // 1. ONE active canonical owner per GTIN — the collision gate.
    uniqueIndex('product_identifiers_canonical_active_key')
      .on(t.canonicalScheme, t.canonicalValue)
      .where(sql`${t.status} = 'active' and ${t.canonicalValue} is not null`),
    // 2. No duplicate ACTIVE assignment of one identifier to one entity.
    uniqueIndex('product_identifiers_variant_active_key')
      .on(t.variantId, t.scheme, t.normalizedValue)
      .where(sql`${t.status} = 'active' and ${t.variantId} is not null`),
    uniqueIndex('product_identifiers_product_active_key')
      .on(t.productId, t.scheme, t.normalizedValue)
      .where(sql`${t.status} = 'active' and ${t.productId} is not null`),
    // Deterministic lookup by what a source actually said (#56 API rule 1).
    index('product_identifiers_scheme_value_idx').on(t.scheme, t.normalizedValue),
    index('product_identifiers_canonical_value_idx').on(t.canonicalValue),
    index('product_identifiers_variant_id_idx').on(t.variantId),
    index('product_identifiers_product_id_idx').on(t.productId),
    index('product_identifiers_source_record_idx').on(t.sourceRecordId),
  ],
);
