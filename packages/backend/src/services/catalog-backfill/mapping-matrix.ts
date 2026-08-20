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

import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import type { LegacyCatalogSubjectKind } from '@mercaria/shared-types';
import {
  categories,
  listingOptions,
  listings,
  productVariantOptionValues,
} from '../../db/schema/catalog.js';
import { productTypeDefinitions } from '../../db/schema/productTypes.js';
import { brandAliases, brands } from '../../db/schema/organizations.js';
import { attributeDefinitions, attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import {
  nativeListingVariantAxes,
  nativeVariantAxisAssignments,
} from '../../db/schema/variantAxes.js';

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
  /**
   * A column THIS epic added as the DESTINATION of the migration.
   *
   * The other ten members all say "this legacy column carries no catalog
   * concept". This one says the opposite and still excludes the column: it
   * carries the concept exactly, and has nothing to map FROM because it is what
   * the mapping maps INTO. Listing it as a legacy source would make the matrix
   * report the epic's own output as unmigrated input.
   */
  'canonical_target',
] as const;

/** One of {@link LEGACY_COLUMN_EXCLUSIONS}. */
export type LegacyColumnExclusion = (typeof LEGACY_COLUMN_EXCLUSIONS)[number];

/**
 * One place a legacy column's concept lands in the universal model.
 *
 * A REFERENCE to a real drizzle table — and optionally to one of its columns —
 * never a string naming one. The previous shape was free text, and the census
 * over it could only measure that the text was long enough: it passed on
 * `native_variant_axis_assignments.position`, a column that does not exist and
 * never did, and would have gone on passing forever (#551).
 *
 * A guard that validates the FORM of its target rather than its EXISTENCE
 * cannot distinguish a correct target from a typo, and reads as coverage either
 * way. So existence is enforced by the TYPE SYSTEM instead — see
 * {@link targetColumn}.
 */
export interface LegacyTargetRef {
  readonly table: AnyPgTable;
  /**
   * The drizzle PROPERTY name of the column, absent when the whole table is the
   * target. The DB name is derived from it by {@link renderTargetRef} rather
   * than written down twice.
   */
  readonly column?: string;
}

/** The whole table is where the concept lives. */
export function targetTable(table: AnyPgTable): LegacyTargetRef {
  return { table };
}

/**
 * One COLUMN of a table is where the concept lives.
 *
 * `K` is derived from the table's own column map, so a column that does not
 * exist is a compile error naming every column that does. That is the gate:
 * a property enforced by the type system needs a gate in the type system, and
 * a string union maintained beside the schema would just be the old free-text
 * failure with extra steps.
 */
export function targetColumn<T extends AnyPgTable, K extends keyof T['_']['columns'] & string>(
  table: T,
  column: K,
): LegacyTargetRef {
  return { table, column };
}

/**
 * `<table>` or `<table>.<column>`, in DB spelling, derived from the schema.
 *
 * Through `sqlColumnName`, never `column.name`: schema modules declare columns
 * in camelCase and drizzle applies `DATABASE_CASING` when SQL is BUILT, so
 * `column.name` is the TypeScript property (`ancestorSlugs`) rather than the SQL
 * name (`ancestor_slugs`). `@oxyhq/db` owns that conversion and is the one
 * authority for it — deriving it here would be a second implementation of the
 * casing rule, which is the thing that authority exists to prevent.
 */
export function renderTargetRef(ref: LegacyTargetRef): string {
  const table = getTableName(ref.table);
  if (ref.column === undefined) return table;
  const column = getTableColumns(ref.table)[ref.column];
  if (column === undefined) throw new Error(`${table} has no column ${ref.column}`);
  return `${table}.${sqlColumnName(column)}`;
}

/**
 * Where a legacy column's concept goes — or a statement that it goes nowhere.
 *
 * A STRING discriminant rather than a boolean one: this backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant, so `if (!t.carried)`
 * would leave the caller holding the whole union.
 *
 * `not_carried` is a real answer and NOT the same as an entry in
 * {@link LEGACY_COLUMNS_WITHOUT_CATALOG_CONCEPT}: that record is for a column
 * carrying no catalog concept at all, while this is for one whose concept is
 * real and is deliberately not represented at the destination's grain.
 */
export type LegacyMappingTarget =
  | { readonly kind: 'carried'; readonly refs: readonly LegacyTargetRef[] }
  | { readonly kind: 'not_carried'; readonly because: string };

/** One legacy column that DOES carry a catalog concept this epic must move. */
export interface LegacyCatalogColumn {
  readonly table: string;
  readonly column: string;
  readonly subject: LegacyCatalogSubjectKind;
  /** Where the concept lives in the universal model, as typed references. */
  readonly target: LegacyMappingTarget;
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
    target: { kind: 'carried', refs: [targetTable(categories)] },
    note:
      'ADR 0007 D2 — extended in place, never replaced. Already a foreign key, so nothing is BACKFILLED into it. What moved is the ' +
      'taxonomy underneath: lifecycle, selectability and effective windows are new, ' +
      'and a row that was valid before this epic can be filed under a merged, ' +
      'deprecated, suppressed, draft or structural node today.',
  },
  {
    table: 'listings',
    column: 'categorySlugs',
    subject: 'listing_category_path',
    target: {
      kind: 'carried',
      refs: [targetColumn(categories, 'ancestorSlugs'), targetColumn(categories, 'slug')],
    },
    note:
      'D13 — a v1 read contract. A denormalized PROJECTION of the assignment, and the only subject this ' +
      'domain writes. `moveCategory` rewrites `categories.ancestor_slugs` for a ' +
      'whole subtree and touches no listing, so a move silently leaves every ' +
      'listing under it stale in the five services that filter on this column.',
  },
  {
    table: 'listings',
    column: 'productType',
    subject: 'listing_product_type_text',
    target: { kind: 'carried', refs: [targetTable(productTypeDefinitions)] },
    note:
      'ADR 0007 D5 — versioned schemas. Free text with no typed counterpart on `listings` at all: ADR 0007 D13 ' +
      'assigns `listings.product_type_definition_id` to the authoring workstream ' +
      'and it has not landed, so this subject is classified and never written.',
  },
  {
    table: 'listings',
    column: 'vendor',
    subject: 'listing_vendor_text',
    target: { kind: 'carried', refs: [targetTable(brands), targetTable(brandAliases)] },
    note:
      '#53/#56. A NAME. #60’s `vendor_brand_candidates` stage already extracts candidates ' +
      'from it, writes provenance and creates no brand; this domain classifies the ' +
      'same values read-only and may never author an attachment.',
  },
  {
    table: 'listing_options',
    column: 'name',
    subject: 'listing_option_name',
    target: {
      kind: 'carried',
      refs: [targetTable(attributeDefinitions), targetTable(nativeListingVariantAxes)],
    },
    note:
      'ADR 0007 D6. #367 step 4 classifies and writes this. Retained verbatim as a ' +
      'claim (D7).',
  },
  {
    table: 'listing_options',
    column: 'values',
    subject: 'listing_option_name',
    target: { kind: 'carried', refs: [targetTable(attributeEnumValues)] },
    note:
      'ADR 0007 D6, through the variant grain only. READ BY NOTHING. Step 4’s `legacyOptionRepository` does not select it, and its ' +
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
    target: {
      kind: 'carried',
      refs: [targetColumn(nativeListingVariantAxes, 'position')],
    },
    note:
      'ADR 0007 D6. Display order, carried across by step 4 — `backfill.service.ts` ' +
      'passes `position: option.position`. Deliberately NOT an input to the ' +
      'variant signature, which is order-independent by construction.',
  },
  {
    table: 'product_variant_option_values',
    column: 'name',
    subject: 'variant_option_value',
    target: {
      kind: 'carried',
      refs: [targetColumn(nativeVariantAxisAssignments, 'attributeDefinitionId')],
    },
    note:
      'ADR 0007 D6. #367 step 4. Resolves by exact key fold; anything else stays text.',
  },
  {
    table: 'product_variant_option_values',
    column: 'value',
    subject: 'variant_option_value',
    target: {
      kind: 'carried',
      refs: [targetColumn(nativeVariantAxisAssignments, 'normalizedValue')],
    },
    note:
      'ADR 0007 D6. #367 step 4. Resolves through `attribute_value_aliases` — the one subject in ' +
      'this matrix whose policy is `alias_evidence_permitted`, because an alias is a ' +
      'human statement that this spelling means that controlled value.',
  },
  {
    table: 'product_variant_option_values',
    column: 'position',
    subject: 'variant_option_value',
    target: {
      kind: 'not_carried',
      because:
        'an assignment is keyed (variant, axis) and has no order, so there is no ' +
        'column for a display position to land in',
    },
    note:
      'Display order, and NOT an input to the signature. This entry named ' +
      '`native_variant_axis_assignments.position` until #551 — a column that does ' +
      'not exist and that no migration ever added, so the claim was an aspiration ' +
      'rather than a rename. What actually happens to the value: ' +
      '`legacyOptionRepository` reads it as an ORDER BY only, and nothing writes ' +
      'it anywhere. Contrast `listing_options.position`, which IS carried — the ' +
      'AXIS has an order, an assignment does not.',
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
  // The #367 box 11 pin (ADR 0007 D5/D10/D13) — the exact product-type version a
  // PUBLISHED listing was authored under. It is this epic's destination column,
  // not a legacy source: `listings.productType` beside it is the free-text
  // platform string the matrix DOES map, and conflating the two would have the
  // backfill read its own output back as input.
  'listings.productTypeDefinitionId': 'canonical_target',
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
