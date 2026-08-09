/**
 * The canonical merchant/storefront layer of the commerce graph — issue #54,
 * bound by ADR 0002: `merchants`, `merchant_aliases`, `merchant_domains`,
 * `merchant_source_links`, `storefronts`, `storefront_aliases`,
 * `storefront_source_links`, `native_store_links`.
 *
 * A MERCHANT is the commercial actor (D3) — one identity however many channels
 * it sells through. A STOREFRONT is one named channel that merchant operates.
 * The existing native `stores` table stays exactly what it is — the
 * OPERATIONAL seller account (members, permissions, inventory, payments) —
 * and meets this layer ONLY through `native_store_links` (D4), at most one
 * active link on each side. Nothing here adds a column to `stores`, and no
 * production flow hard-deletes a canonical row: retirement and merge are
 * status transitions (D12/D16), which is why intra-graph foreign keys are
 * RESTRICT and CASCADE is reserved for pure child annotations (D20).
 *
 * ## The marketplace fact is DERIVED, never stored (D8)
 *
 * A future offer (#57) names its seller of record (`offers.merchant_id`) and
 * its channel (`offers.storefront_id`). "Marketplace offer" means the
 * storefront's operator is a DIFFERENT merchant than the seller of record —
 * a comparison of two foreign keys, deliberately not a stored flag, so "Sold
 * by Amazon" (merchant Amazon on Amazon's own storefront) and "Sold by Shop X
 * on Amazon" (merchant Shop X on Amazon's storefront) cannot collapse. This
 * file's contribution is that both roles exist as separate rows with real
 * keys; the offers table itself is #57's and is NOT anticipated here.
 *
 * ## Built on `canonicalSupport.ts` (#53), as ADR 0002 D25 binds
 *
 * The lifecycle, alias-row and source-link-row shapes are stated ONCE, in
 * #53's `canonicalSupport.ts` (`canonicalLifecycleColumns()`, `aliasColumns()`,
 * `sourceLinkColumns()`) — this file spreads them and adds only what a helper
 * cannot: each table's entity FK, its CHECKs (a CHECK needs the table name),
 * its uniques and its indexes. Every `source_record_id` here is a REAL
 * `.references()` onto #53's `source_records`, RESTRICT (D19: provenance must
 * be able to block a delete). During parallel development these five columns
 * were carried as DEFERRED foreign keys; the integration flip to real
 * constraints is exactly what `db/deferredForeignKeys.ts`'s gate forced.
 *
 * The organization relationship (issue requirement 4) is deliberately NOT a
 * column on `merchants`: per D17, *organization operates merchant* is an
 * assertable, temporal, evidence-gated fact — a `commerce_relationships` row
 * (#55) — not containment. A nullable `organization_id` here would be a second
 * representation of that fact, which is the exact disagreement D8/D17 exist to
 * make unrepresentable.
 *
 * ## Native-checkout eligibility is DERIVED (issue requirement 7)
 *
 * There is no `checkoutable`/`eligible` column anywhere in this file. Only
 * `native` offers reach checkout structurally (D18), so eligibility is a
 * read-time conjunction — claim verdict plus active native-store link —
 * computed in `services/commerce-graph/merchant.service.ts` and never stored.
 */

import { sql, type SQL } from 'drizzle-orm';
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
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  CANONICAL_ALIAS_KINDS,
  CANONICAL_ENTITY_STATUSES,
  CLAIM_STATES,
  MERCHANT_DOMAIN_STATUSES,
  MERCHANT_TYPES,
  NATIVE_STORE_LINK_METHODS,
  NATIVE_STORE_LINK_STATUSES,
  SOURCE_LINK_METHODS,
  SOURCE_LINK_STATUSES,
  STOREFRONT_CHANNEL_KINDS,
  STOREFRONT_VERIFICATION_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { aliasColumns, canonicalLifecycleColumns, sourceLinkColumns } from './canonicalSupport';
import { sourceRecords } from './provenance';
import { stores } from './stores';

/**
 * `merchants` — the canonical seller identity (ADR 0002 D3/D9/D12).
 *
 * `claim_state` is the ONE stored claim verdict (D9), following
 * `provider_accounts.onboarding_state`: the claiming FLOW belongs to #40/#83
 * and only ever moves this column — there is deliberately no boolean beside
 * it. `status`/`merged_into_id` are the merge/suppression/redirect substrate
 * (D12): the merge OPERATION itself belongs to #59's tooling and its
 * `catalog_revisions` ledger, but the tombstone shape, the flattened one-hop
 * redirect and the never-reused slug are pinned here.
 *
 * `rating`/`rating_count`/`offer_count` are aggregate ROLLUPS (issue
 * requirement 8) — display state maintained by the surfaces that own the
 * underlying rows (#57 for offers). Nothing operational (permissions,
 * members, payouts) exists here; that is the native store's, always (D4).
 */
export const merchants = pgTable(
  'merchants',
  {
    id: generatedId(),
    /** Canonical display name. Alternate spellings are ALIASES, never a rename. */
    name: text().notNull(),
    /**
     * URL identity, unique FOREVER: a merged tombstone keeps its slug so the
     * old URL resolves through `merged_into_id`, and no new row may take it
     * (D12). The service layer mints slugs via `ensureUniqueSlug`.
     */
    slug: text().notNull(),
    merchantType: text({ enum: asEnumValues(MERCHANT_TYPES) }),
    description: text(),
    claimState: text({ enum: asEnumValues(CLAIM_STATES) }).notNull().default('unclaimed'),
    /** An Oxy account id — no foreign key; Oxy owns identity. Written by #40/#83. */
    claimedByOxyUserId: text(),
    claimedAt: timestamptz(),
    /**
     * The FINAL merge winner — flattened on write (D16), so resolution is one
     * hop. RESTRICT: a winner cannot vanish from under its tombstones.
     * Declared per-table (not in the lifecycle helper) because a self-FK needs
     * the table constant.
     */
    mergedIntoId: text().references((): AnyPgColumn => merchants.id, { onDelete: 'restrict' }),
    /** Aggregate mean rating, 0 when unrated — a computed mean, hence a float. */
    rating: doublePrecision().notNull().default(0),
    ratingCount: integer().notNull().default(0),
    /** Rollup of offers attributed to this merchant; #57 maintains it. */
    offerCount: integer().notNull().default(0),
    /**
     * Name search, `'simple'` config (D21): proper nouns must not be
     * English-stemmed — "Nike" is not a verb. Aliases are a separate table a
     * fuzzy search UNIONs in; a generated column cannot read another table.
     */
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${merchants.name})`,
    ),
    // status / firstSeenAt / lastSeenAt / lastReviewedAt / pinnedFields /
    // createdAt / updatedAt — the ONE lifecycle shape (D12, canonicalSupport).
    ...canonicalLifecycleColumns(),
  },
  (t) => [
    checkOneOf('merchants_merchant_type_check', t.merchantType, MERCHANT_TYPES),
    checkOneOf('merchants_claim_state_check', t.claimState, CLAIM_STATES),
    checkOneOf('merchants_status_check', t.status, CANONICAL_ENTITY_STATUSES),
    // `status = 'merged'` and `merged_into_id` are one fact in two columns, so
    // their agreement is a CHECK rather than a convention: a tombstone without
    // a winner is unresolvable, and a winner on a live row is a silent merge.
    check(
      'merchants_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    uniqueIndex('merchants_slug_key').on(t.slug),
    // Issue #54 requires a status index; paired with created_at as the browse
    // order, the same shape `stores` uses.
    index('merchants_status_created_at_idx').on(t.status, t.createdAt.desc()),
    index('merchants_search_vector_idx').using('gin', t.searchVector),
  ],
);

/**
 * `merchant_aliases` — alternate/historical/localized names (ADR 0002 D16).
 *
 * The row shape is `aliasColumns()` (canonicalSupport, D16): `normalized_alias`
 * GENERATED as `lower(btrim(alias))`, so no write path can store an alias
 * whose lookup key disagrees with its display form, and `source_record_id` a
 * real RESTRICT reference onto `source_records`. Unique per (merchant,
 * normalized form); the trigram GIN serves both the exact lookup API and
 * typo-tolerant search (pg_trgm supports equality on PostgreSQL 17 — see
 * `migrate.ts`, which requires the extension).
 */
export const merchantAliases = pgTable(
  'merchant_aliases',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('merchant_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('merchant_aliases_merchant_id_normalized_alias_key').on(
      t.merchantId,
      t.normalizedAlias,
    ),
    index('merchant_aliases_normalized_alias_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/**
 * `merchant_domains` — public-website observations and verified domains
 * (issue #54, merchant requirement 5).
 *
 * OBSERVATION and VERIFICATION are one lifecycle on one row, not two tables:
 * many merchants may be OBSERVED at one domain (that is a dispute for #59, not
 * a constraint violation), but at most ONE may hold it VERIFIED — the partial
 * unique below is the domain-collision gate, and it is what stops
 * `apple-store-madrid.example` claiming to be Apple by assertion (D10's rule:
 * name/domain similarity may create an observation, never a verification).
 *
 * The lowercase CHECK makes normalization structural: a case-variant spelling
 * cannot dodge either unique.
 */
export const merchantDomains = pgTable(
  'merchant_domains',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    /** Normalized lowercase hostname — no scheme, no path, no port. */
    domain: text().notNull(),
    status: text({ enum: asEnumValues(MERCHANT_DOMAIN_STATUSES) })
      .notNull()
      .default('observed'),
    firstObservedAt: timestamptz().notNull(),
    lastObservedAt: timestamptz().notNull(),
    verifiedAt: timestamptz(),
    /** An Oxy account id — no foreign key. NULL for #83's automated verification. */
    verifiedByOxyUserId: text(),
    /**
     * The observation this domain came from, when imported. RESTRICT (D19):
     * provenance must be able to block a delete, not vanish with it.
     */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_domains_status_check', t.status, MERCHANT_DOMAIN_STATUSES),
    check(
      'merchant_domains_domain_normalized_check',
      sql`${t.domain} = lower(btrim(${t.domain}))`,
    ),
    // A verification without a time is not a verification anybody can audit.
    check(
      'merchant_domains_verified_state_check',
      sql`${t.status} <> 'verified' or ${t.verifiedAt} is not null`,
    ),
    uniqueIndex('merchant_domains_merchant_id_domain_key').on(t.merchantId, t.domain),
    // THE collision gate: one verified holder per domain, ever, at a time.
    uniqueIndex('merchant_domains_domain_verified_key')
      .on(t.domain)
      .where(sql`${t.status} = 'verified'`),
    // Domain lookup across all statuses (the verified partial covers only one).
    index('merchant_domains_domain_idx').on(t.domain),
  ],
);

/**
 * `merchant_source_links` — source record → merchant, ADR 0002 D19's shape.
 *
 * Canonical rows own NOTHING about sources; the link row is where a matching
 * decision lives, gets its confidence and gets reviewed (#59). `confidence`
 * is NULL for deterministic or human decisions — a number appears only on
 * machine matches, and never substitutes for review (D19).
 */
export const merchantSourceLinks = pgTable(
  'merchant_source_links',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    // sourceRecordId (real RESTRICT FK) / method / matchRule / confidence /
    // status / decidedByOxyUserId / timestamps — the ONE D19 shape.
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('merchant_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('merchant_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'merchant_source_links_confidence_check',
      sql`${t.confidence} >= 0 and ${t.confidence} <= 1`,
    ),
    // One ACTIVE link per (entity, record) — the D22 convergence key; a
    // superseded/rejected decision stays as history without blocking a re-match.
    uniqueIndex('merchant_source_links_merchant_id_source_record_id_key')
      .on(t.merchantId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('merchant_source_links_source_record_id_idx').on(t.sourceRecordId),
  ],
);

/**
 * `storefronts` — one named sales channel a merchant operates (ADR 0002 D3).
 *
 * Apple Store Spain, Apple Store France and Apple's Amazon presence are three
 * rows, all pointing at ONE merchant; territory lives HERE, never on the
 * merchant. `merchant_id` is NOT NULL and RESTRICT — a storefront cannot exist
 * without its merchant, and a merchant with channels cannot be deleted out
 * from under them (canonical rows are never hard-deleted anyway, D20).
 *
 * `(provider, external_shop_id)` is the source-identity convergence key
 * (D22): re-observing the same external shop converges on one row instead of
 * minting duplicates. Only a `merged` tombstone releases the key — its
 * identity has moved to the winner.
 *
 * The NATIVE channel is deliberately NOT a storefront row: native offers
 * derive their seller from the listing's owner and carry no storefront (D18),
 * and the native store itself meets the graph only through
 * `native_store_links` (D4) — a second meeting point here could disagree with
 * the first.
 */
export const storefronts = pgTable(
  'storefronts',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    /** URL identity, unique forever — same tombstone rule as `merchants.slug`. */
    slug: text().notNull(),
    channelKind: text({ enum: asEnumValues(STOREFRONT_CHANNEL_KINDS) }).notNull(),
    /**
     * The external platform's own id (`shopify`, `amazon`, …). An OPEN set —
     * external key spaces are not Mercaria's to enumerate — so no CHECK, like
     * `connections`' provider column family it does not share a tuple with.
     */
    provider: text(),
    /** Normalized lowercase hostname when the channel is domain-addressed. */
    domain: text(),
    /** The source platform's own shop id — a foreign key space (ledgered, no FK). */
    externalShopId: text(),
    /** ISO 3166-1 alpha-2 primary market; NULL = not market-scoped. */
    country: text(),
    /** Lowercased BCP-47 tags; NULL = unknown (absence, not an empty set). */
    languages: text().array(),
    /**
     * The channel's OWN currency as its platform reports it. Shape-checked,
     * deliberately NOT tuple-checked: an external platform may report a code
     * outside Mercaria's presentment set, and refusing the row would break the
     * observation rather than a price — the `connections.shop_currency`
     * exemption class, registered in `CONVENTIONS.md`. Nothing prices against
     * it.
     */
    currency: text(),
    publicUrl: text(),
    /** Whether outbound affiliate routing (#67) can target this channel. */
    affiliateCapable: boolean().notNull().default(false),
    /** Self-FK per-table for the same reason as `merchants.mergedIntoId`. */
    mergedIntoId: text().references((): AnyPgColumn => storefronts.id, { onDelete: 'restrict' }),
    /**
     * Moved only by a SUCCESSFUL refresh (#68's sweeps). Distinct from the
     * lifecycle's `lastSeenAt` (ANY sighting moves that) and from
     * `lastReviewedAt` (an operator looked) — three different facts, and
     * collapsing any two would make one of them a lie.
     */
    lastRefreshedAt: timestamptz(),
    /**
     * Whether the operating merchant's control of this channel is verified —
     * one stored verdict, the D9 pattern. Verification MECHANISMS (domain
     * control, platform verification) arrive with #83/#55 and move this
     * column; nothing re-derives it.
     */
    verificationState: text({ enum: asEnumValues(STOREFRONT_VERIFICATION_STATES) })
      .notNull()
      .default('unverified'),
    verifiedAt: timestamptz(),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${storefronts.name})`,
    ),
    // status / firstSeenAt / lastSeenAt / lastReviewedAt / pinnedFields /
    // createdAt / updatedAt — the ONE lifecycle shape (D12, canonicalSupport).
    ...canonicalLifecycleColumns(),
  },
  (t) => [
    checkOneOf('storefronts_channel_kind_check', t.channelKind, STOREFRONT_CHANNEL_KINDS),
    checkOneOf('storefronts_status_check', t.status, CANONICAL_ENTITY_STATUSES),
    checkOneOf(
      'storefronts_verification_state_check',
      t.verificationState,
      STOREFRONT_VERIFICATION_STATES,
    ),
    check(
      'storefronts_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'storefronts_domain_normalized_check',
      sql`${t.domain} = lower(btrim(${t.domain}))`,
    ),
    check('storefronts_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('storefronts_currency_check', sql`${t.currency} ~ '^[A-Z]{3,4}$'`),
    check(
      'storefronts_verified_state_check',
      sql`${t.verificationState} <> 'verified' or ${t.verifiedAt} is not null`,
    ),
    uniqueIndex('storefronts_slug_key').on(t.slug),
    // The source-identity convergence key (issue #54: provider + external id).
    uniqueIndex('storefronts_provider_external_shop_id_key')
      .on(t.provider, t.externalShopId)
      .where(
        sql`${t.provider} is not null and ${t.externalShopId} is not null and ${t.status} <> 'merged'`,
      ),
    index('storefronts_merchant_id_idx').on(t.merchantId),
    index('storefronts_domain_idx')
      .on(t.domain)
      .where(sql`${t.domain} is not null`),
    // Issue #54 requires a status index; last_seen_at is the order the refresh
    // and staleness surfaces (#68) read it in.
    index('storefronts_status_last_seen_at_idx').on(t.status, t.lastSeenAt.desc()),
    index('storefronts_search_vector_idx').using('gin', t.searchVector),
  ],
);

/** `storefront_aliases` — the D16 alias shape, for storefronts. */
export const storefrontAliases = pgTable(
  'storefront_aliases',
  {
    id: generatedId(),
    storefrontId: text()
      .notNull()
      .references(() => storefronts.id, { onDelete: 'cascade' }),
    ...aliasColumns(),
  },
  (t) => [
    checkOneOf('storefront_aliases_kind_check', t.kind, CANONICAL_ALIAS_KINDS),
    uniqueIndex('storefront_aliases_storefront_id_normalized_alias_key').on(
      t.storefrontId,
      t.normalizedAlias,
    ),
    index('storefront_aliases_normalized_alias_idx').using(
      'gin',
      t.normalizedAlias.op('gin_trgm_ops'),
    ),
  ],
);

/** `storefront_source_links` — the D19 source-link shape, for storefronts. */
export const storefrontSourceLinks = pgTable(
  'storefront_source_links',
  {
    id: generatedId(),
    storefrontId: text()
      .notNull()
      .references(() => storefronts.id, { onDelete: 'cascade' }),
    ...sourceLinkColumns(),
  },
  (t) => [
    checkOneOf('storefront_source_links_method_check', t.method, SOURCE_LINK_METHODS),
    checkOneOf('storefront_source_links_status_check', t.status, SOURCE_LINK_STATUSES),
    check(
      'storefront_source_links_confidence_check',
      sql`${t.confidence} >= 0 and ${t.confidence} <= 1`,
    ),
    uniqueIndex('storefront_source_links_storefront_id_source_record_id_key')
      .on(t.storefrontId, t.sourceRecordId)
      .where(sql`${t.status} = 'active'`),
    index('storefront_source_links_source_record_id_idx').on(t.sourceRecordId),
  ],
);

/**
 * `native_store_links` — the verified, REVERSIBLE 1:1 join between a canonical
 * merchant and a native `stores` row (ADR 0002 D4; issue #54, linkage 1–5).
 *
 * The two paired partial uniques are the cardinality D4 states in words: at
 * most one ACTIVE link per store AND per merchant, so one real-world seller
 * resolves to one merchant whether encountered natively or externally.
 * Revoked rows remain — the mapping is reversible and its history is the
 * audit trail, which is why the actor, method and time are NOT NULL: a link
 * that cannot say who verified it and how is exactly the name-match-only link
 * this table exists to refuse. `verification_method`'s closed set has no
 * name-match member, deliberately.
 *
 * Both entity FKs are RESTRICT: there is no code path that deletes a `Store`
 * today (see `stores.ts`), and if one ever appears, an active canonical link
 * is a fact it must confront rather than silently orphan. Store members,
 * permissions, policies, inventory and orders remain on the native store —
 * this row grants NOTHING operational in either direction.
 */
export const nativeStoreLinks = pgTable(
  'native_store_links',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    status: text({ enum: asEnumValues(NATIVE_STORE_LINK_STATUSES) })
      .notNull()
      .default('active'),
    /** HOW the link was verified. NOT NULL — an unverified link cannot exist. */
    verificationMethod: text({ enum: asEnumValues(NATIVE_STORE_LINK_METHODS) }).notNull(),
    verificationNote: text(),
    /** An Oxy account id — no foreign key. The verifying actor, mandatory. */
    verifiedByOxyUserId: text().notNull(),
    verifiedAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('native_store_links_status_check', t.status, NATIVE_STORE_LINK_STATUSES),
    checkOneOf(
      'native_store_links_verification_method_check',
      t.verificationMethod,
      NATIVE_STORE_LINK_METHODS,
    ),
    // A revocation without a time and an actor is not an auditable reversal.
    check(
      'native_store_links_revoked_state_check',
      sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null)`,
    ),
    // D4's cardinality, enforced rather than conventioned: ≤1 active per side.
    uniqueIndex('native_store_links_store_id_active_key')
      .on(t.storeId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('native_store_links_merchant_id_active_key')
      .on(t.merchantId)
      .where(sql`${t.status} = 'active'`),
    // History reads (all links a store/merchant ever had, revoked included).
    index('native_store_links_store_id_idx').on(t.storeId),
    index('native_store_links_merchant_id_idx').on(t.merchantId),
  ],
);
