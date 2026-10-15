/**
 * Organizations are references to Oxy's central directory. Mercaria keeps only
 * graph lifecycle and historical URL/merge/evidence references. Current names,
 * logos, domains and legal facts are never stored or edited here.
 * Brands remain Mercaria's separate commercial marks, with their own provenance.
 * Migration archives are frozen evidence and are never used to serve identity.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { generatedId, tsvector, createdAt } from '@oxy.so/db';
import {
  CANONICAL_ALIAS_KINDS,
  CANONICAL_ENTITY_STATUSES,
  SOURCE_LINK_METHODS,
  SOURCE_LINK_STATUSES,
} from '@mercaria/shared-types';
import { checkOneOf } from './columns';
import { aliasColumns, canonicalLifecycleColumns, sourceLinkColumns } from './canonicalSupport';
import { sourceRecords } from './provenance';

/** Commerce relationship references; Oxy owns their organization identity. */
export const organizations = pgTable(
  'organizations',
  {
    id: generatedId(),
    /** Opaque canonical Oxy account id. Several historical graph nodes may resolve to one company. */
    oxyAccountId: text().notNull(),
    /** Historical Mercaria URL; retained forever for incoming links. */
    slug: text().notNull(),
    mergedIntoId: text().references((): AnyPgColumn => organizations.id, { onDelete: 'restrict' }),
    ...canonicalLifecycleColumns(),
  },
  (t) => [
    checkOneOf('organizations_status_check', t.status, CANONICAL_ENTITY_STATUSES),
    check(
      'organizations_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'organizations_merged_into_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    check('organizations_oxy_account_id_nonempty_check', sql`length(btrim(${t.oxyAccountId})) > 0`),
    uniqueIndex('organizations_slug_key').on(t.slug),
    index('organizations_oxy_account_id_idx').on(t.oxyAccountId),
  ],
);

/** Immutable migration evidence. Never a serving source for company identity. */
export const organizationIdentityArchives = pgTable(
  'organization_identity_archives',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    legalName: text(),
    websiteUrl: text(),
    verifiedDomains: text().array().notNull(),
    countryCode: text(),
    logoFileId: text(),
    logoSourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    archivedAt: createdAt(),
  },
  (t) => [uniqueIndex('organization_identity_archives_organization_id_key').on(t.organizationId)],
);

/** `brands` — the consumer-facing mark. Never a seller, never a legal entity. */
export const brands = pgTable(
  'brands',
  {
    id: generatedId(),
    /** URL-safe canonical handle; unique forever, tombstones keep theirs. */
    slug: text().notNull(),
    /** Canonical display name — original form, never a normalization. */
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
    websiteUrl: text(),
    /** Observed domains — accumulated facts, explicitly NOT ownership proof. */
    observedDomains: text().array().notNull().default(sql`'{}'::text[]`),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    logoFileId: text(),
    /** The observation that supplied the logo; rights come off its source. */
    logoSourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * Derived counts (#53 brand rule 6) — the seam #56/#57's chokepoints
     * maintain once canonical products and offers exist. Until then always 0;
     * nothing in #53 pretends to compute them.
     */
    productCount: integer().notNull().default(0),
    activeOfferCount: integer().notNull().default(0),
    /** See `organizations.mergedIntoId` — same rule, same reasons. */
    mergedIntoId: text().references((): AnyPgColumn => brands.id, { onDelete: 'restrict' }),
    ...canonicalLifecycleColumns(),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', coalesce(${brands.name}, ''))`,
    ),
  },
  (t) => [
    checkOneOf('brands_status_check', t.status, CANONICAL_ENTITY_STATUSES),
    check(
      'brands_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'brands_merged_into_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('brands_slug_key').on(t.slug),
    index('brands_normalized_name_idx').on(t.normalizedName),
    index('brands_normalized_name_trgm_idx').using('gin', t.normalizedName.op('gin_trgm_ops')),
    index('brands_observed_domains_idx').using('gin', t.observedDomains),
    index('brands_search_vector_idx').using('gin', t.searchVector),
  ],
);

/**
 * `organization_aliases` — every name an organization has ever been called.
 * Shape: `aliasColumns()` in `canonicalSupport.ts`; per-entity tables so every
 * alias row has a REAL foreign key (ADR 0002 D16).
 */
/** Frozen pre-centralization alias evidence; never used for identity lookup or authoring. */
export const organizationAliases = pgTable(
  'organization_aliases',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('organization_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('organization_aliases_organization_id_normalized_alias_key').on(
      t.organizationId,
      t.normalizedAlias,
    ),
    // Exact reverse lookup (alias → entity) is a btree; typo-tolerant candidate
    // lookup is the trigram GIN. The compound unique above serves neither: it
    // leads with the entity id.
    index('organization_aliases_normalized_alias_idx').on(t.normalizedAlias),
    index('organization_aliases_normalized_alias_trgm_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/** `brand_aliases` — see `organization_aliases`. */
export const brandAliases = pgTable(
  'brand_aliases',
  {
    id: generatedId(),
    brandId: text()
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('brand_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('brand_aliases_brand_id_normalized_alias_key').on(t.brandId, t.normalizedAlias),
    index('brand_aliases_normalized_alias_idx').on(t.normalizedAlias),
    index('brand_aliases_normalized_alias_trgm_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/**
 * `organization_source_links` — source record → organization, the ONLY path by
 * which a source references the entity (ADR 0002 D19). Shape:
 * `sourceLinkColumns()` in `canonicalSupport.ts`.
 *
 * The partial unique is the convergence key: at most one ACTIVE link per
 * (entity, record), while superseded/rejected history rows accumulate freely —
 * a merge repoints history without colliding with the winner's own links.
 */
export const organizationSourceLinks = pgTable(
  'organization_source_links',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('organization_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('organization_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'organization_source_links_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('organization_source_links_active_key')
      .on(t.organizationId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    // Reverse lookup: which entity does this observation support?
    index('organization_source_links_source_record_id_idx').on(t.sourceRecordId),
  ],
);

/** `brand_source_links` — see `organization_source_links`. */
export const brandSourceLinks = pgTable(
  'brand_source_links',
  {
    id: generatedId(),
    brandId: text()
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('brand_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('brand_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'brand_source_links_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('brand_source_links_active_key')
      .on(t.brandId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('brand_source_links_source_record_id_idx').on(t.sourceRecordId),
  ],
);
