/**
 * Canonical organizations and brands (#53, ADR 0002 D1/D12/D16/D20/D21):
 * `organizations`, `brands`, their alias tables and their source-link tables.
 *
 * An ORGANIZATION is the accountable actor (Apple Inc.); a BRAND is a
 * consumer-facing mark (Apple). Separate tables because the relationship is
 * many-to-many OVER TIME — the connection between them is a
 * `commerce_relationships` row (#55) with evidence, never a `company` column
 * here and never name equality (D1 forbids both).
 *
 * ## Identity rules encoded structurally
 *
 * - **Tombstones, not deletes.** A merged row survives with `status='merged'`
 *   and `merged_into_id` pointing at the FINAL winner (flattened on write, so
 *   resolution is one hop). Slugs are unique with no partial index — a
 *   tombstone keeps its slug forever, which is what makes "never reused"
 *   structural (D12).
 * - **Aliases are search input, never identity.** One row per name a thing has
 *   ever been called, `normalized_alias` GENERATED from the display form, and a
 *   trigram GIN (D21) for typo-tolerant candidate lookup. The display form is
 *   preserved verbatim — normalization is for candidate GENERATION only, and a
 *   normalized match alone never merges anything (that is a service rule pinned
 *   by test, since no constraint can express "do not act on this similarity").
 * - **Provenance is links, not columns.** Neither table carries a source id;
 *   `<entity>_source_links` (downstream of both sides, D19) is where matching
 *   decisions live. The ONE column-level exception is `logo_source_record_id`,
 *   which is not ownership of a source but attribution of a specific ASSET to
 *   the observation that supplied it — usage rights are read off that record's
 *   source registry row.
 * - **`normalized_name` is a plain column maintained by the write service**
 *   (the `listings` denormalized-facet precedent), NOT generated: real
 *   normalization (accents, punctuation, legal suffixes) is application
 *   vocabulary that evolves, and a generated-column rewrite silently drops the
 *   column's indexes (see CONVENTIONS.md).
 * - **`search_vector` uses the `'simple'` configuration** (D21): proper nouns
 *   must not be English-stemmed — "Nike" is not a verb.
 *
 * ## Domains: two different claims, two different columns
 *
 * `organizations.verified_domains` holds domains VERIFIED for the organization
 * — evidence-backed, written only by services holding that evidence.
 * `brands.observed_domains` holds domains OBSERVED for a brand — accumulated
 * facts that are explicitly NOT ownership proof (#53 brand rule 5). A domain
 * match is evidence for review, never an automatic connection.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { generatedId, tsvector } from '@oxyhq/db';
import {
  CANONICAL_ALIAS_KINDS,
  CANONICAL_ENTITY_STATUSES,
  SOURCE_LINK_METHODS,
  SOURCE_LINK_STATUSES,
} from '@mercaria/shared-types';
import { checkOneOf } from './columns';
import { aliasColumns, canonicalLifecycleColumns, sourceLinkColumns } from './canonicalSupport';
import { sourceRecords } from './provenance';

/** `organizations` — the accountable legal/operating entity. */
export const organizations = pgTable(
  'organizations',
  {
    id: generatedId(),
    /** URL-safe canonical handle; unique forever, tombstones keep theirs. */
    slug: text().notNull(),
    /** Canonical display name — original form, never a normalization. */
    name: text().notNull(),
    /** Service-maintained normalization of `name`, for candidate generation. */
    normalizedName: text().notNull(),
    /** Legal or operating name when known ("Apple Inc."). */
    legalName: text(),
    websiteUrl: text(),
    /** Evidence-backed domains. Written only by services holding the evidence. */
    verifiedDomains: text().array().notNull().default(sql`'{}'::text[]`),
    /** ISO 3166-1 alpha-2 home country/market, when known. */
    countryCode: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    logoFileId: text(),
    /** The observation that supplied the logo; rights come off its source. */
    logoSourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * The FINAL merge winner, set exactly when `status = 'merged'`. `restrict`:
     * a redirect target can never be deleted out from under its tombstones.
     */
    mergedIntoId: text().references((): AnyPgColumn => organizations.id, { onDelete: 'restrict' }),
    ...canonicalLifecycleColumns(),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', coalesce(${organizations.name}, ''))`,
    ),
  },
  (t) => [
    checkOneOf('organizations_status_check', t.status, CANONICAL_ENTITY_STATUSES),
    // A tombstone without a target is unresolvable and a target on a live row is
    // a contradiction — the two facts move together or not at all.
    check(
      'organizations_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'organizations_merged_into_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    check(
      'organizations_country_code_check',
      sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    uniqueIndex('organizations_slug_key').on(t.slug),
    index('organizations_normalized_name_idx').on(t.normalizedName),
    index('organizations_normalized_name_trgm_idx').using(
      'gin',
      t.normalizedName.op('gin_trgm_ops'),
    ),
    index('organizations_verified_domains_idx').using('gin', t.verifiedDomains),
    index('organizations_search_vector_idx').using('gin', t.searchVector),
  ],
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
    check('brands_merged_into_self_check', sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`),
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
