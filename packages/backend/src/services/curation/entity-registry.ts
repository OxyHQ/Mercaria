/**
 * The ONE place a `MergeableEntityType` maps to the rows that carry it (#59).
 *
 * Every other module in this domain asks this registry which table an entity
 * lives in, which column holds its tombstone pointer and which alias table
 * should receive its `former_name` row. Nothing switches on the entity type
 * twice: a second switch is a second answer, and the day the two disagree is
 * the day a merge stamps a tombstone on one table and rehomes the children of
 * another.
 *
 * The `claim-methods.ts` device — a TABLE of properties rather than a `switch`
 * — with one addition that matters here: every field is a real drizzle column,
 * so a renamed column is a `tsc` error rather than a query that finds nothing.
 */

import { getTableConfig, type AnyPgColumn, type AnyPgTable } from 'drizzle-orm/pg-core';
import type { MergeableEntityType } from '@mercaria/shared-types';
import {
  brandAliases,
  brands,
  brandSourceLinks,
  organizationAliases,
  organizations,
  organizationSourceLinks,
} from '../../db/schema/organizations.js';
import {
  merchantAliases,
  merchants,
  merchantSourceLinks,
  storefrontAliases,
  storefronts,
  storefrontSourceLinks,
} from '../../db/schema/merchants.js';
import {
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProductFamilyAliases,
  canonicalProductFamilyRedirects,
  canonicalProductFamilySourceLinks,
  canonicalProductRedirects,
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariantAliases,
  canonicalVariants,
  canonicalVariantSourceLinks,
} from '../../db/schema/canonicalCatalog.js';

/** Everything the curation domain needs to know about one mergeable entity. */
export interface CuratedEntityDefinition {
  readonly table: AnyPgTable;
  readonly idColumn: AnyPgColumn;
  /**
   * The URL identity, unique FOREVER (ADR 0002 D12).
   *
   * NULL for a canonical VARIANT, which is the one mergeable entity with no
   * slug: a variant is addressed through its product, never on its own, so
   * there is no URL for a merge to redirect and no redirect HISTORY table for
   * it either. Stating the absence here is what stops a caller assuming one.
   */
  readonly slugColumn: AnyPgColumn | null;
  /** The display name a `former_name` alias is minted from. Nullable on a variant. */
  readonly nameColumn: AnyPgColumn;
  readonly statusColumn: AnyPgColumn;
  /** The tombstone pointer — set exactly when `status = 'merged'`, by CHECK. */
  readonly mergedIntoColumn: AnyPgColumn;
  readonly aliasTable: AnyPgTable;
  readonly aliasEntityColumn: AnyPgColumn;
  /** The alias's own display column, which `aliasColumns()` normalizes from. */
  readonly aliasValueColumn: AnyPgColumn;
  readonly sourceLinkTable: AnyPgTable;
  readonly sourceLinkEntityColumn: AnyPgColumn;
  readonly sourceLinkRecordColumn: AnyPgColumn;
  readonly sourceLinkStatusColumn: AnyPgColumn;
  /**
   * The append-only hop history (`canonical_product_redirects` and its family
   * twin). Present only where ADR 0002 D16's chain FLATTENING would otherwise
   * lose a hop — that is, on the two entities whose merges are chained often
   * enough for "where did this point before" to be a real question, and which
   * are URL-addressable so an old link has to resolve.
   *
   * Its absence elsewhere is not a gap: `merged_into_id` still answers "where
   * does this point NOW" for every one of the seven, and the `catalog_revisions`
   * timeline records every hop for all of them.
   */
  readonly redirectTable: AnyPgTable | null;
  readonly redirectFromColumn: AnyPgColumn | null;
  readonly redirectToColumn: AnyPgColumn | null;
}

/**
 * The registry.
 *
 * `Record<MergeableEntityType, …>` rather than a lookup with a fallback, so a
 * type added to the tuple without an entry is a compile error and never a
 * runtime "unknown entity" that a caller has to remember to handle.
 */
export const CURATED_ENTITIES: Readonly<Record<MergeableEntityType, CuratedEntityDefinition>> = {
  organization: {
    table: organizations,
    idColumn: organizations.id,
    slugColumn: organizations.slug,
    nameColumn: organizations.name,
    statusColumn: organizations.status,
    mergedIntoColumn: organizations.mergedIntoId,
    aliasTable: organizationAliases,
    aliasEntityColumn: organizationAliases.organizationId,
    aliasValueColumn: organizationAliases.alias,
    sourceLinkTable: organizationSourceLinks,
    sourceLinkEntityColumn: organizationSourceLinks.organizationId,
    sourceLinkRecordColumn: organizationSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: organizationSourceLinks.status,
    redirectTable: null,
    redirectFromColumn: null,
    redirectToColumn: null,
  },
  brand: {
    table: brands,
    idColumn: brands.id,
    slugColumn: brands.slug,
    nameColumn: brands.name,
    statusColumn: brands.status,
    mergedIntoColumn: brands.mergedIntoId,
    aliasTable: brandAliases,
    aliasEntityColumn: brandAliases.brandId,
    aliasValueColumn: brandAliases.alias,
    sourceLinkTable: brandSourceLinks,
    sourceLinkEntityColumn: brandSourceLinks.brandId,
    sourceLinkRecordColumn: brandSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: brandSourceLinks.status,
    redirectTable: null,
    redirectFromColumn: null,
    redirectToColumn: null,
  },
  merchant: {
    table: merchants,
    idColumn: merchants.id,
    slugColumn: merchants.slug,
    nameColumn: merchants.name,
    statusColumn: merchants.status,
    mergedIntoColumn: merchants.mergedIntoId,
    aliasTable: merchantAliases,
    aliasEntityColumn: merchantAliases.merchantId,
    aliasValueColumn: merchantAliases.alias,
    sourceLinkTable: merchantSourceLinks,
    sourceLinkEntityColumn: merchantSourceLinks.merchantId,
    sourceLinkRecordColumn: merchantSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: merchantSourceLinks.status,
    redirectTable: null,
    redirectFromColumn: null,
    redirectToColumn: null,
  },
  storefront: {
    table: storefronts,
    idColumn: storefronts.id,
    slugColumn: storefronts.slug,
    nameColumn: storefronts.name,
    statusColumn: storefronts.status,
    mergedIntoColumn: storefronts.mergedIntoId,
    aliasTable: storefrontAliases,
    aliasEntityColumn: storefrontAliases.storefrontId,
    aliasValueColumn: storefrontAliases.alias,
    sourceLinkTable: storefrontSourceLinks,
    sourceLinkEntityColumn: storefrontSourceLinks.storefrontId,
    sourceLinkRecordColumn: storefrontSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: storefrontSourceLinks.status,
    redirectTable: null,
    redirectFromColumn: null,
    redirectToColumn: null,
  },
  canonical_product_family: {
    table: canonicalProductFamilies,
    idColumn: canonicalProductFamilies.id,
    slugColumn: canonicalProductFamilies.slug,
    nameColumn: canonicalProductFamilies.name,
    statusColumn: canonicalProductFamilies.status,
    mergedIntoColumn: canonicalProductFamilies.mergedIntoId,
    aliasTable: canonicalProductFamilyAliases,
    aliasEntityColumn: canonicalProductFamilyAliases.familyId,
    aliasValueColumn: canonicalProductFamilyAliases.alias,
    sourceLinkTable: canonicalProductFamilySourceLinks,
    sourceLinkEntityColumn: canonicalProductFamilySourceLinks.familyId,
    sourceLinkRecordColumn: canonicalProductFamilySourceLinks.sourceRecordId,
    sourceLinkStatusColumn: canonicalProductFamilySourceLinks.status,
    redirectTable: canonicalProductFamilyRedirects,
    redirectFromColumn: canonicalProductFamilyRedirects.fromId,
    redirectToColumn: canonicalProductFamilyRedirects.toId,
  },
  canonical_product: {
    table: canonicalProducts,
    idColumn: canonicalProducts.id,
    slugColumn: canonicalProducts.slug,
    nameColumn: canonicalProducts.name,
    statusColumn: canonicalProducts.status,
    mergedIntoColumn: canonicalProducts.mergedIntoId,
    aliasTable: canonicalProductAliases,
    aliasEntityColumn: canonicalProductAliases.productId,
    aliasValueColumn: canonicalProductAliases.alias,
    sourceLinkTable: canonicalProductSourceLinks,
    sourceLinkEntityColumn: canonicalProductSourceLinks.productId,
    sourceLinkRecordColumn: canonicalProductSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: canonicalProductSourceLinks.status,
    redirectTable: canonicalProductRedirects,
    redirectFromColumn: canonicalProductRedirects.fromId,
    redirectToColumn: canonicalProductRedirects.toId,
  },
  canonical_variant: {
    table: canonicalVariants,
    idColumn: canonicalVariants.id,
    // A variant has no URL of its own — see the field's doc comment.
    slugColumn: null,
    nameColumn: canonicalVariants.name,
    statusColumn: canonicalVariants.status,
    mergedIntoColumn: canonicalVariants.mergedIntoId,
    aliasTable: canonicalVariantAliases,
    aliasEntityColumn: canonicalVariantAliases.variantId,
    aliasValueColumn: canonicalVariantAliases.alias,
    sourceLinkTable: canonicalVariantSourceLinks,
    sourceLinkEntityColumn: canonicalVariantSourceLinks.variantId,
    sourceLinkRecordColumn: canonicalVariantSourceLinks.sourceRecordId,
    sourceLinkStatusColumn: canonicalVariantSourceLinks.status,
    redirectTable: null,
    redirectFromColumn: null,
    redirectToColumn: null,
  },
};

/** The Postgres table name of a mergeable entity — for logs and error messages. */
export function curatedTableName(entityType: MergeableEntityType): string {
  return getTableConfig(CURATED_ENTITIES[entityType].table).name;
}
