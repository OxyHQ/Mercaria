/**
 * The legacy → universal mapping matrix, as DATA — #367 workstream 13's
 * inventory deliverable.
 *
 * "Produce a mapping matrix from each legacy field to the new canonical domain"
 * and "audit all current category, product type, vendor/brand, option and
 * variant fields" are one requirement with two halves, and the half that goes
 * wrong is the audit: a matrix somebody wrote once covers the columns that
 * existed the day they wrote it, and a hole in a map reads exactly like flat
 * ground.
 *
 * So the matrix is a PARTITION, checked against the real drizzle tables by
 * `mapping-matrix-census.test.ts`: every column of the three legacy tables is
 * either mapped to a subject here or excluded with a stated reason, and the
 * union is the table's whole column set. A column added to `listings` fails the
 * build until somebody decides what the migration does with it — which is the
 * point, and it is `merge-plan-census.test.ts`'s device applied to a migration
 * rather than to a merge.
 *
 * ## This file makes no decisions
 *
 * The classes, policies, writers and review owners all live in
 * `@mercaria/shared-types` `catalog-backfill.ts` as `Record`s over the subject
 * and reason tuples. What is here is the COLUMN inventory, which is backend
 * knowledge (a drizzle column name is not a DTO) and belongs nowhere a client
 * could read it.
 */

import { getTableColumns } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import type { LegacyCatalogSubjectKind } from '@mercaria/shared-types';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
} from '../../db/schema/catalog.js';

/**
 * Why a column of a legacy table is not a legacy CATALOG-CLASSIFICATION concept.
 *
 * A closed vocabulary rather than free text, so the exclusions can be counted
 * and read as a group. A one-word reason per column is cheap to add and
 * impossible to leave blank, which is what keeps the partition honest as
 * `listings` grows.
 */
export const LEGACY_COLUMN_EXCLUSIONS = [
  /** The row's own primary key. */
  'row_identity',
  /** Who owns the listing. Oxy owns identity; this epic does not touch it. */
  'ownership',
  /** Seller-authored display text. ADR 0007 D1: presentation, never identity. */
  'presentation',
  /** Where the listing is in its commercial life. */
  'commerce_state',
  /** #90's condition taxonomy, which has already had its own migration. */
  'condition_domain',
  /** Denormalized from variants or reviews by an existing chokepoint. */
  'derived_facet',
  /** Physical location. Pickup and proximity, not classification. */
  'geo',
  /** Connector provenance — where the listing was PULLED from. */
  'connector_provenance',
  /** Row timestamps. */
  'timestamps',
  /** Merchandising keywords. See the note on `tags`. */
  'merchandising',
] as const;

/** One of {@link LEGACY_COLUMN_EXCLUSIONS}. */
export type LegacyColumnExclusion = (typeof LEGACY_COLUMN_EXCLUSIONS)[number];

/** One legacy column that DOES carry a catalog concept this epic must move. */
export interface LegacyCatalogColumn {
  readonly table: string;
  readonly column: string;
  readonly subject: LegacyCatalogSubjectKind;
  /** The domain that owns the concept in the universal model. */
  readonly target: string;
  /** What is true of this column specifically, beyond its subject's policy. */
  readonly note: string;
}

/**
 * Every legacy column carrying a catalog concept, and where that concept lives
 * now.
 *
 * The `target` is a table or a domain in the universal model, never a DTO field:
 * the question this answers is "where does this fact belong", and a DTO is a
 * projection of an answer rather than the answer.
 */
export const LEGACY_CATALOG_COLUMNS: readonly LegacyCatalogColumn[] = [
  {
    table: 'listings',
    column: 'categoryId',
    subject: 'listing_category_assignment',
    target: 'categories (ADR 0007 D2 — extended in place, never replaced)',
    note:
      'Already a foreign key, so nothing is BACKFILLED into it. What moved is the ' +
      'taxonomy underneath: lifecycle, selectability and effective windows are new, ' +
      'and a row that was valid before this epic can be filed under a merged, ' +
      'deprecated, suppressed, draft or structural node today.',
  },
  {
    table: 'listings',
    column: 'categorySlugs',
    subject: 'listing_category_path',
    target: 'categories.ancestor_slugs + categories.slug (D13 — a v1 read contract)',
    note:
      'A denormalized PROJECTION of the assignment, and the only subject this ' +
      'domain writes. `moveCategory` rewrites `categories.ancestor_slugs` for a ' +
      'whole subtree and touches no listing, so a move silently leaves every ' +
      'listing under it stale in the five services that filter on this column.',
  },
  {
    table: 'listings',
    column: 'productType',
    subject: 'listing_product_type_text',
    target: 'product_type_definitions (ADR 0007 D5 — versioned schemas)',
    note:
      'Free text with no typed counterpart on `listings` at all: ADR 0007 D13 ' +
      'assigns `listings.product_type_definition_id` to the authoring workstream ' +
      'and it has not landed, so this subject is classified and never written.',
  },
  {
    table: 'listings',
    column: 'vendor',
    subject: 'listing_vendor_text',
    target: 'brands + brand_aliases (#53/#56)',
    note:
      'A NAME. #60’s `vendor_brand_candidates` stage already extracts candidates ' +
      'from it, writes provenance and creates no brand; this domain classifies the ' +
      'same values read-only and may never author an attachment.',
  },
  {
    table: 'listing_options',
    column: 'name',
    subject: 'listing_option_name',
    target: 'attribute_definitions + native_listing_variant_axes (ADR 0007 D6)',
    note: '#367 step 4 classifies and writes this. Retained verbatim as a claim (D7).',
  },
  {
    table: 'listing_options',
    column: 'values',
    subject: 'listing_option_name',
    target: 'attribute_enum_values (ADR 0007 D6), through the variant grain only',
    note:
      'READ BY NOTHING. Step 4’s `legacyOptionRepository` does not select it, and its ' +
      'listing-level claim carries `rawValue: null` — the per-VARIANT values in ' +
      '`product_variant_option_values` are what become assignments. A declared option ' +
      'value no variant uses is therefore retained only as the legacy row itself (D13 ' +
      'keeps the table), and is typed nowhere. Stated rather than fixed: inventing a ' +
      'variant to carry it would invent a SKU.',
  },
  {
    table: 'listing_options',
    column: 'position',
    subject: 'listing_option_name',
    target: 'native_listing_variant_axes.position (ADR 0007 D6)',
    note:
      'Display order, carried across by step 4. Deliberately NOT an input to the ' +
      'variant signature, which is order-independent by construction.',
  },
  {
    table: 'product_variant_option_values',
    column: 'name',
    subject: 'variant_option_value',
    target: 'native_variant_axis_assignments.attribute_definition_id (ADR 0007 D6)',
    note: '#367 step 4. Resolves by exact key fold; anything else stays text.',
  },
  {
    table: 'product_variant_option_values',
    column: 'value',
    subject: 'variant_option_value',
    target: 'native_variant_axis_assignments.normalized_value (ADR 0007 D6)',
    note:
      '#367 step 4. Resolves through `attribute_value_aliases` — the one subject in ' +
      'this matrix whose policy is `alias_evidence_permitted`, because an alias is a ' +
      'human statement that this spelling means that controlled value.',
  },
  {
    table: 'product_variant_option_values',
    column: 'position',
    subject: 'variant_option_value',
    target: 'native_variant_axis_assignments.position (ADR 0007 D6)',
    note: 'Display order. Not an input to the signature.',
  },
];

/**
 * Every remaining column of the three legacy tables, with the reason it carries
 * no catalog concept.
 *
 * A `Record` keyed by `<table>.<column>`, because that is what the census
 * compares against and a pair of parallel arrays would let one drift.
 */
export const LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT: Readonly<
  Record<string, LegacyColumnExclusion>
> = {
  'listings.id': 'row_identity',
  'listings.ownerType': 'ownership',
  'listings.oxyUserId': 'ownership',
  'listings.storeId': 'ownership',
  'listings.title': 'presentation',
  'listings.description': 'presentation',
  'listings.handle': 'presentation',
  'listings.seoTitle': 'presentation',
  'listings.seoDescription': 'presentation',
  'listings.status': 'commerce_state',
  'listings.publishedAt': 'commerce_state',
  'listings.archivedBy': 'commerce_state',
  'listings.archivedFromStatus': 'commerce_state',
  'listings.condition': 'condition_domain',
  'listings.conditionAssertion': 'condition_domain',
  'listings.conditionSourceLabel': 'condition_domain',
  'listings.conditionAcknowledgedAt': 'condition_domain',
  'listings.priceRangeMinAmount': 'derived_facet',
  'listings.priceRangeMinCurrency': 'derived_facet',
  'listings.priceRangeMaxAmount': 'derived_facet',
  'listings.priceRangeMaxCurrency': 'derived_facet',
  'listings.hasInventory': 'derived_facet',
  'listings.variantCount': 'derived_facet',
  'listings.rating': 'derived_facet',
  'listings.reviewCount': 'derived_facet',
  'listings.favoriteCount': 'derived_facet',
  'listings.searchVector': 'derived_facet',
  'listings.latitude': 'geo',
  'listings.longitude': 'geo',
  'listings.geo': 'geo',
  'listings.sourceConnectionId': 'connector_provenance',
  'listings.sourceProvider': 'connector_provenance',
  'listings.sourceExternalId': 'connector_provenance',
  'listings.sourceExternalUpdatedAt': 'connector_provenance',
  'listings.overriddenFields': 'connector_provenance',
  // Keywords, not classification. Named here rather than left out because `tags`
  // is the column somebody reaches for when the `product_type_no_registered_key`
  // count comes back high — a tag is seller-entered free text with no registry
  // behind it, and mining one for a category is
  // `LEGACY_CATALOG_FORBIDDEN_SIGNALS.listing_tag_keyword`.
  'listings.tags': 'merchandising',
  'listings.createdAt': 'timestamps',
  'listings.updatedAt': 'timestamps',
  'listing_options.id': 'row_identity',
  'listing_options.listingId': 'row_identity',
  'listing_options.createdAt': 'timestamps',
  'listing_options.updatedAt': 'timestamps',
  'product_variant_option_values.id': 'row_identity',
  'product_variant_option_values.variantId': 'row_identity',
  'product_variant_option_values.createdAt': 'timestamps',
  'product_variant_option_values.updatedAt': 'timestamps',
};

/** The three tables the partition covers, by the name the matrix uses. */
export const LEGACY_CATALOG_TABLES: Readonly<Record<string, AnyPgTable>> = {
  listings,
  listing_options: listingOptions,
  product_variant_option_values: productVariantOptionValues,
};

/** `<table>.<column>` for every column of the three legacy tables, sorted. */
export function legacyCatalogColumnKeys(): readonly string[] {
  return Object.entries(LEGACY_CATALOG_TABLES)
    .flatMap(([table, drizzleTable]) =>
      Object.values(getTableColumns(drizzleTable)).map((column) => `${table}.${column.name}`),
    )
    .sort();
}
