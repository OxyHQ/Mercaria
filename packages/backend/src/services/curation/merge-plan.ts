/**
 * THE REHOMING PLAN — what a merge does with every row that references the
 * losing entity (#59 merge invariant 2).
 *
 * ## Why this is a data structure and not a sequence of hand-written UPDATEs
 *
 * "Source mappings, offers, relationships, price history, reviews, product
 * saves, alerts and watchlists are rehomed idempotently" is a claim about
 * COMPLETENESS, and completeness is exactly what a hand-written merge cannot
 * prove. Finding fewer referencing tables looks identical to there BEING fewer
 * (`~/Oxy/AGENTS.md`, the pathspec and Mongo-reader findings), and the miss is
 * silent — the orphaned rows keep pointing at a tombstone nobody reads.
 *
 * So the plan is declared here as real drizzle COLUMNS, and
 * `__tests__/merge-plan-census.test.ts` walks the drizzle schema for every
 * foreign key that targets a mergeable entity and asserts the plan covers
 * EXACTLY that set — no more, no fewer. A new table referencing
 * `canonical_products` therefore fails the build until somebody decides what a
 * merge does with it. That is the point: the decision is forced at the moment
 * the reference is added, by the person adding it, rather than discovered by a
 * seller months later.
 *
 * ## The dispositions, and why `untouched` is a first-class answer
 *
 * A table that must NOT move is as much a decision as one that must, and a plan
 * that could only express "move it" would either move history that belongs to
 * the tombstone or force whoever wrote it to leave the table out — which the
 * census would then read as an omission. Every `untouched` and
 * `retained_by_tombstone` entry carries its reason in the row, so the census
 * failure message can quote it back.
 */

import { getTableConfig, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import type { CatalogMergeConflictKind, CatalogMergePhase, MergeableEntityType } from '@mercaria/shared-types';
import {
  bundleComponents,
  canonicalAttributeValues,
  canonicalFieldProvenance,
  canonicalImages,
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProductFamilyAliases,
  canonicalProductFamilyRedirects,
  canonicalProductFamilySourceLinks,
  canonicalProductRedirects,
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariantAliases,
  canonicalVariantAttributes,
  canonicalVariants,
  canonicalVariantSourceLinks,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
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
  merchantDomains,
  merchants,
  merchantSourceLinks,
  nativeStoreLinks,
  storefrontAliases,
  storefronts,
  storefrontSourceLinks,
} from '../../db/schema/merchants.js';
import { merchantClaims } from '../../db/schema/merchantClaims.js';
import { commerceRelationships } from '../../db/schema/relationships.js';
import { nativeListingLinks, offers } from '../../db/schema/offers.js';
import { storeLinkageOfferOverlaps, storeLinkageRequests } from '../../db/schema/storeLinkage.js';
import { reviewAggregates, reviewEligibilities, reviews } from '../../db/schema/reviews.js';
import { matchBlockedPairs, matchDecisionCandidates, matchDecisions } from '../../db/schema/matching.js';
import { procurementOffers, suppliers } from '../../db/schema/procurement.js';
import { catalogMergeConflicts } from '../../db/schema/curation.js';
import {
  retailComplianceEvidence,
  retailEligibilityExceptions,
  retailSuppressions,
} from '../../db/schema/retailEligibility.js';
import { catalogBackfillRecords } from '../../db/schema/backfill.js';
import { productSaveAggregates, productSaves } from '../../db/schema/productSaves.js';
import { offerPriceSeries } from '../../db/schema/priceHistory.js';
import {
  catalogSourceConfigs,
  marketplaceSellerIdentities,
} from '../../db/schema/ingestion.js';

/**
 * What the merge does with one referencing column.
 *
 * - `repoint` — the plain move. No unique spans this column, so every row goes.
 * - `repoint_if_absent` — a unique spans `(column, …uniqueWith)`, and the
 *   winner may already hold the same combination. Colliding rows STAY on the
 *   tombstone, which loses nothing: the winner already has that alias, that
 *   image, that attribute value.
 * - `repoint_or_supersede` — the same collision, on a table whose partial
 *   unique is scoped to an ACTIVE status. The colliding row moves AND is
 *   superseded, so the loser's provenance history follows its entity instead of
 *   being stranded. ADR 0002 D19's source-link design names exactly this.
 * - `conflict_gated` — a unique the merge CANNOT resolve on its own, because
 *   which side survives is a judgement. The planning phase raises a
 *   `catalog_merge_conflicts` row and the job blocks (#59 merge invariant 4).
 * - `flatten` — the self-reference. Tombstones that pointed at the loser are
 *   retargeted at the winner so resolution stays one hop (ADR 0002 D16).
 * - `retained_by_tombstone` — the row stays with the loser ON PURPOSE, because
 *   it describes what the loser WAS.
 * - `untouched` — the merge must not write this table at all.
 */
export type RehomeDisposition =
  | 'repoint'
  | 'repoint_if_absent'
  | 'repoint_or_supersede'
  | 'conflict_gated'
  | 'flatten'
  | 'retained_by_tombstone'
  | 'untouched';

/** One referencing column and what the merge does with it. */
export interface RehomeTarget {
  /** The column holding the entity id. A real drizzle column, so a rename breaks the build. */
  readonly column: AnyPgColumn;
  /** Which phase moves it. Ordering is the plan's, not the runner's. */
  readonly phase: CatalogMergePhase;
  readonly disposition: RehomeDisposition;
  /**
   * The other columns of the unique this move could violate. Required by
   * `repoint_if_absent` and `repoint_or_supersede`, and meaningless otherwise.
   */
  readonly uniqueWith?: readonly AnyPgColumn[];
  /**
   * The status column a `repoint_or_supersede` writes, and the value that takes
   * a row out of the partial unique's predicate.
   */
  readonly statusColumn?: AnyPgColumn;
  readonly supersededStatus?: string;
  /**
   * A predicate narrowing which rows the move applies to — used where a partial
   * unique is scoped (an ACTIVE offer, an OPEN relationship) and the rest of the
   * table moves freely.
   */
  readonly activeStatusColumn?: AnyPgColumn;
  readonly activeStatusValue?: string;
  /**
   * Columns set to the WINNER's id alongside `column`, because the row stores
   * the same id twice and a CHECK requires the copies to agree.
   *
   * `retail_suppressions` is the case that needs it (#121): it carries a typed
   * foreign key AND the polymorphic `scope_ref` the eligibility derivation
   * actually matches on, with `retail_suppressions_reference_agreement_check`
   * forcing them equal. Moving one alone fails that CHECK outright — loudly,
   * which is the good outcome — and moving neither would leave a RECALL keyed on
   * a tombstone while the surviving identity sold freely.
   */
  readonly alsoSetColumns?: readonly AnyPgColumn[];
  /**
   * Restricts the absence guard to rows where this column is NULL, matching a
   * partial unique's own predicate.
   *
   * Without it the guard is wider than the constraint: a LIFTED suppression on
   * the winner would block a LIVE one from following its entity, and the merge
   * would silently un-suppress a recalled product. The guard must be exactly as
   * wide as the index it guards, never wider.
   */
  readonly guardWhereNullColumn?: AnyPgColumn;
  /** Which conflict a `conflict_gated` target raises. */
  readonly conflictKind?: CatalogMergeConflictKind;
  /** Why, in one sentence. Quoted back by the census when it fails. */
  readonly note: string;
}

/** The alias-table shape every entity shares — one entry, seven times. */
function aliasTarget(column: AnyPgColumn, normalizedAlias: AnyPgColumn): RehomeTarget {
  return {
    column,
    phase: 'aliases',
    disposition: 'repoint_if_absent',
    uniqueWith: [normalizedAlias],
    note:
      'Aliases are search input, never identity (ADR 0002 D16). A name the winner already ' +
      'carries stays on the tombstone: repointing it would violate the per-entity unique and ' +
      'nothing is lost, because the winner already answers that name.',
  };
}

/** The source-link shape every entity shares — one entry, seven times. */
function sourceLinkTarget(column: AnyPgColumn, sourceRecordId: AnyPgColumn, status: AnyPgColumn): RehomeTarget {
  return {
    column,
    phase: 'source_links',
    disposition: 'repoint_or_supersede',
    uniqueWith: [sourceRecordId],
    statusColumn: status,
    supersededStatus: 'superseded',
    note:
      "ADR 0002 D19's own design: the partial unique is scoped to ACTIVE links, so a merge " +
      "repoints the loser's provenance history without colliding with the winner's, and a " +
      'link the winner already holds actively arrives SUPERSEDED rather than being left behind.',
  };
}

/** The `merged_into_id` self-reference every entity carries. */
function flattenTarget(column: AnyPgColumn): RehomeTarget {
  return {
    column,
    phase: 'redirects',
    disposition: 'flatten',
    note:
      'ADR 0002 D16 chain flattening: every tombstone that pointed at the loser is retargeted ' +
      'at the winner, so resolution stays ONE hop however many merges an identity has been ' +
      'through. The hop that is overwritten survives in `catalog_revisions`.',
  };
}

/**
 * A redirect-history table's own two columns.
 *
 * `from_id` moves so the losing entity's recorded hops follow it; `to_id` is
 * retargeted so a hop that pointed AT the loser now points at the winner —
 * which is the append-only record of the flattening above.
 */
function redirectHistoryTargets(fromColumn: AnyPgColumn, toColumn: AnyPgColumn): readonly RehomeTarget[] {
  return [
    {
      column: fromColumn,
      phase: 'redirects',
      disposition: 'untouched',
      note:
        'A hop OUT of the loser is history about the loser and stays keyed on it. Moving it ' +
        'would claim the winner had once redirected somewhere it never did.',
    },
    {
      column: toColumn,
      phase: 'redirects',
      disposition: 'repoint_if_absent',
      uniqueWith: [fromColumn],
      note:
        'A hop INTO the loser must follow the flattening, or an old URL resolves to a ' +
        'tombstone. `(from_id, to_id)` is unique, so a hop the winner already records stays.',
    },
  ];
}

const RELATIONSHIP_NOTE =
  "An evidence-backed claim's endpoint. `commerce_relationships_open_claim_key` holds one OPEN " +
  'claim per (kind, endpoints), so two claims that would collapse into one are a judgement an ' +
  'operator makes — which of them keeps its evidence — and never a silent pick.';

const OFFER_NOTE =
  '`offers_active_commercial_key` holds one ACTIVE offer per (canonical variant, seller, ' +
  'channel, condition). Two offers collapsing into one is a decision about which price a ' +
  'buyer sees, and the merge refuses to make it.';

const IDENTIFIER_NOTE =
  "ADR 0002 D14's collision gate: one ACTIVE canonical owner per GTIN. #59 merge invariant 4 " +
  'names this case by itself — an identifier conflict is resolved explicitly BEFORE commit, ' +
  'never by whichever row the UPDATE happened to reach first.';

const SUPPRESSION_NOTE =
  "#121's recall / stop-sale. It MUST follow the surviving identity: a suppression left on a " +
  'tombstone stops covering the product people can actually buy, which un-suppresses a recalled ' +
  'item. The row stores the id TWICE — the typed foreign key and the polymorphic `scope_ref` the ' +
  'eligibility derivation matches on — and `retail_suppressions_reference_agreement_check` forces ' +
  'them equal, so both move together. The guard is exactly as wide as ' +
  '`retail_suppressions_live_key` (`(scope, scope_ref, kind) WHERE lifted_at IS NULL`): a LIVE ' +
  "suppression the winner already holds absorbs the loser's, and a LIFTED one does not block it.";

const COMPLIANCE_NOTE =
  "#121's compliance document for a canonical product or variant. It follows the surviving " +
  'identity, because the alternative is a product that was compliant becoming BLOCKED by a merge ' +
  '— the derivation demands a document covering the destination market, and evidence stranded on ' +
  'a tombstone covers nothing. The markets the document is valid in are its own column and are ' +
  'untouched, so a merge can never widen where a certificate applies.';

const BACKFILL_RECORD_NOTE =
  "#60's migration REPORT row, and it stays with the tombstone. Its whole purpose is comparing a " +
  'dry run against the apply run that followed it (`UNIQUE(mapping_version, mode, stage, ' +
  'subject_key)`), so repointing it would rewrite what a run actually reported — the same reason ' +
  "its own trigger freezes the record's identity. A reader still resolves the entity through " +
  '`merged_into_id`, which is one hop by construction (ADR 0002 D16).';

const MATCH_HISTORY_NOTE =
  'A matching decision records what the pipeline concluded about an entity that still exists ' +
  'under a new identity, so it follows the winner — otherwise a re-evaluation would find no ' +
  'prior decision and re-propose a merge an operator already answered.';

const PRODUCT_SAVE_NOTE =
  "#80's canonical product save — a person's standing interest in this product, and #80 " +
  'migration rule 7 requires a merge to rehome it automatically. The guard is exactly ' +
  '`product_saves_oxy_user_id_canonical_product_id_key`: a buyer who saved BOTH sides already ' +
  'has a save on the winner, so their loser-side row stays on the tombstone and the saved-items ' +
  'read excludes a merged product — which loses nothing precisely BECAUSE the twin exists, and ' +
  'is the only reading under which that exclusion is safe. Repointing it instead would violate ' +
  'the unique and abort the phase.';

const PRICE_SERIES_NOTE =
  "#78's derived price series — the `review_aggregates` and `product_save_aggregates` " +
  'disposition, for their reason plus one of its own. It is a PROJECTION: the loser\'s row ' +
  'answers a question about the loser and stays with it, and the winner\'s is REBUILT rather ' +
  'than merged, because two series cannot be concatenated — each of their points names the ' +
  'ONE cheapest eligible observation in its bucket, and the cheapest across both is neither ' +
  'list. The rebuild needs no rehoming at all: an observation carries no canonical id, the ' +
  'offers it belongs to have already been repointed by the `offers` phase, and re-running the ' +
  'derivation therefore picks up the loser\'s whole history under the winner. A rebuild of the ' +
  'tombstone\'s own series yields zero points for the same reason, so it self-clears rather ' +
  'than sitting as a stale answer forever. `rebuildEntityAggregates` requests both.';

const PRODUCT_SAVE_AGGREGATE_NOTE =
  "#80's derived save counter. The `review_aggregates` disposition for the `review_aggregates` " +
  "reason: the loser's row describes what the loser was saved by and stays with it, and the " +
  "winner's is REBUILT from the rehomed saves rather than summed with it (#59 merge invariant " +
  '6). Adding the two would double-count every buyer who saved both, and a count has no rows ' +
  'beside it to catch that with.';

/**
 * The plan, per mergeable entity.
 *
 * `Record<MergeableEntityType, …>` so a type added without a plan is a compile
 * error, and the census then checks each plan against the schema.
 */
export const MERGE_REHOMING_PLAN: Readonly<Record<MergeableEntityType, readonly RehomeTarget[]>> = {
  organization: [
    flattenTarget(organizations.mergedIntoId),
    aliasTarget(organizationAliases.organizationId, organizationAliases.normalizedAlias),
    sourceLinkTarget(
      organizationSourceLinks.organizationId,
      organizationSourceLinks.sourceRecordId,
      organizationSourceLinks.status,
    ),
    {
      column: commerceRelationships.organizationId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note: RELATIONSHIP_NOTE,
    },
    {
      column: suppliers.organizationId,
      phase: 'children',
      disposition: 'repoint',
      note:
        'A supplier names the organization it buys from. Nothing is unique on the pair, so the ' +
        'move is unconditional — a supplier whose organization was merged still buys from the ' +
        'same company under its surviving identity.',
    },
  ],

  brand: [
    flattenTarget(brands.mergedIntoId),
    aliasTarget(brandAliases.brandId, brandAliases.normalizedAlias),
    sourceLinkTarget(brandSourceLinks.brandId, brandSourceLinks.sourceRecordId, brandSourceLinks.status),
    {
      column: canonicalProductFamilies.brandId,
      phase: 'children',
      disposition: 'repoint',
      note: "A family's brand. Unconditional: nothing is unique on (brand, family).",
    },
    {
      column: canonicalProducts.brandId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "The product's OWN brand, which ADR 0002 D13 makes the authority for identifier " +
        'scoping — so it has to follow the surviving brand or every brand-scoped identifier ' +
        'lookup on those products changes answer.',
    },
    {
      column: retailSuppressions.brandId,
      phase: 'offers',
      disposition: 'repoint_if_absent',
      uniqueWith: [retailSuppressions.scope, retailSuppressions.kind],
      alsoSetColumns: [retailSuppressions.scopeRef],
      guardWhereNullColumn: retailSuppressions.liftedAt,
      note: SUPPRESSION_NOTE,
    },
    {
      column: commerceRelationships.brandId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note: RELATIONSHIP_NOTE,
    },
    {
      column: commerceRelationships.relatedBrandId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note:
        `${RELATIONSHIP_NOTE} This is the OBJECT side of a brand-succeeds-brand claim, and it ` +
        'is gated separately because a merge can collapse both ends of one succession.',
    },
  ],

  merchant: [
    flattenTarget(merchants.mergedIntoId),
    aliasTarget(merchantAliases.merchantId, merchantAliases.normalizedAlias),
    sourceLinkTarget(
      merchantSourceLinks.merchantId,
      merchantSourceLinks.sourceRecordId,
      merchantSourceLinks.status,
    ),
    {
      column: merchantDomains.merchantId,
      phase: 'children',
      disposition: 'repoint_if_absent',
      uniqueWith: [merchantDomains.domain],
      note:
        'Observed and verified hostnames. A domain the winner already records stays on the ' +
        'tombstone; the unique is per (merchant, domain) and a duplicate proves nothing new.',
    },
    {
      column: storefronts.merchantId,
      phase: 'children',
      disposition: 'repoint',
      note:
        'ADR 0002 D3: a storefront is a CHANNEL of a merchant, never a second merchant. ' +
        'Merging two merchants merges the operator of their channels and nothing else about ' +
        'the channels themselves.',
    },
    {
      column: merchantClaims.merchantId,
      phase: 'children',
      disposition: 'conflict_gated',
      conflictKind: 'verified_claim',
      note:
        "#83's `(merchant_id) WHERE state='verified'` partial unique means two claimed " +
        'merchants cannot become one without deciding whose claim survives — and that decision ' +
        'is who may operate the surviving merchant, which no merge may make on its own.',
    },
    {
      column: nativeStoreLinks.merchantId,
      phase: 'children',
      disposition: 'repoint_if_absent',
      uniqueWith: [nativeStoreLinks.storeId],
      note:
        "#84's merchant↔native-store link. A link the winner already holds to the same store " +
        'stays behind; the unique is what stops one store answering to two merchants.',
    },
    {
      column: storeLinkageRequests.merchantId,
      phase: 'children',
      disposition: 'repoint',
      note: 'A linkage REQUEST is a record of what was asked, and it follows the surviving merchant.',
    },
    {
      column: storeLinkageOfferOverlaps.merchantId,
      phase: 'offers',
      disposition: 'repoint',
      note: "#84's overlap finding, evidence about the merchant's offers; it follows them.",
    },
    {
      column: catalogSourceConfigs.merchantId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "#62's source binding: the seller of record every offer from that feed belongs to. It " +
        'follows the surviving merchant, and it must — the binding is the ONLY path from an ' +
        'ingested record to a merchant id, so a source left pointing at a tombstone would ' +
        'stop producing offers with no error anywhere. No unique spans it, because two feeds ' +
        'legitimately sell for one merchant.',
    },
    {
      column: marketplaceSellerIdentities.merchantId,
      phase: 'children',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        marketplaceSellerIdentities.provider,
        marketplaceSellerIdentities.externalSellerId,
      ],
      note:
        "#65's marketplace-account identity: which merchant one eBay seller account IS. It " +
        'follows the surviving merchant, and a COLLIDING identity — the same (provider, ' +
        'external seller id) already recorded against the winner — stays on the tombstone, ' +
        'because the unique means the two rows were always the same account and repointing ' +
        'would refuse the whole merge over a duplicate that proves nothing new. The consequence ' +
        'if it were repointed blindly is worse than a failed merge: this row is the ONLY path ' +
        'from an ingested item to its seller, so two of them for one account would let the next ' +
        'pass attribute the same seller to two merchants.',
    },
    {
      column: commerceRelationships.merchantId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note: RELATIONSHIP_NOTE,
    },
    {
      column: offers.merchantId,
      phase: 'offers',
      disposition: 'conflict_gated',
      conflictKind: 'active_offer',
      activeStatusColumn: offers.status,
      activeStatusValue: 'active',
      note: OFFER_NOTE,
    },
    {
      column: reviews.merchantId,
      phase: 'reviews',
      disposition: 'repoint',
      note:
        "A buyer's review of a seller follows the seller. #76 makes `review_aggregates` a " +
        'PROJECTION, so the numbers are rebuilt in the `rollups` phase rather than added up ' +
        'across two entities (#59 merge invariant 6).',
    },
    {
      column: reviewEligibilities.merchantId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [reviewEligibilities.orderItemId, reviewEligibilities.oxyUserId, reviewEligibilities.scope],
      note:
        "The right to review, evidenced by an order line. `UNIQUE(order_item_id, oxy_user_id, " +
        'scope)` already holds, so a grant the winner carries for the same line stays behind — ' +
        'the buyer keeps exactly one right to review, which is the point of that unique.',
    },
    {
      column: reviewAggregates.merchantId,
      phase: 'reviews',
      disposition: 'retained_by_tombstone',
      note:
        "#76 makes the aggregate a PROJECTION of the reviews. The loser's row describes what " +
        'the loser scored and stays with it; the winner\'s is REBUILT from the rehomed reviews ' +
        'in `rollups`, never incremented (#59 merge invariant 6).',
    },
    {
      column: productSaves.preferredMerchantId,
      phase: 'saves',
      disposition: 'repoint',
      note:
        "#80's optional preferred SELLER on a product save. Unconditional: nothing is unique on " +
        'this column, and a buyer who narrowed their save to a merchant meant the business, ' +
        'which after a merge trades under the surviving identity. Left on a tombstone the ' +
        'preference would match no offer and quietly empty their saved-product page.',
    },
  ],

  storefront: [
    flattenTarget(storefronts.mergedIntoId),
    aliasTarget(storefrontAliases.storefrontId, storefrontAliases.normalizedAlias),
    sourceLinkTarget(
      storefrontSourceLinks.storefrontId,
      storefrontSourceLinks.sourceRecordId,
      storefrontSourceLinks.status,
    ),
    {
      column: commerceRelationships.storefrontId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note: `${RELATIONSHIP_NOTE} On a storefront the column is SCOPE rather than an endpoint, and it is part of \`endpoint_key\` all the same.`,
    },
    {
      column: offers.storefrontId,
      phase: 'offers',
      disposition: 'conflict_gated',
      conflictKind: 'active_offer',
      activeStatusColumn: offers.status,
      activeStatusValue: 'active',
      note: OFFER_NOTE,
    },
    {
      column: catalogSourceConfigs.storefrontId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "#62's source binding, the channel half. Same reasoning as the merchant column: a " +
        'source pointing at a tombstoned storefront would keep ingesting and publish its ' +
        'offers on a channel nobody reads. No unique spans it.',
    },
  ],

  canonical_product_family: [
    flattenTarget(canonicalProductFamilies.mergedIntoId),
    aliasTarget(canonicalProductFamilyAliases.familyId, canonicalProductFamilyAliases.normalizedAlias),
    sourceLinkTarget(
      canonicalProductFamilySourceLinks.familyId,
      canonicalProductFamilySourceLinks.sourceRecordId,
      canonicalProductFamilySourceLinks.status,
    ),
    ...redirectHistoryTargets(
      canonicalProductFamilyRedirects.fromId,
      canonicalProductFamilyRedirects.toId,
    ),
    {
      column: canonicalProducts.familyId,
      phase: 'children',
      disposition: 'repoint',
      note: 'The line\'s products follow the surviving line. Nothing is unique on (family, product).',
    },
    {
      column: canonicalFieldProvenance.familyId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalFieldProvenance.field],
      note:
        'Which source supplied each SELECTED field. One row per (entity, field), so a field the ' +
        "winner already explains keeps its own explanation — the loser's stays as the record of " +
        'what the losing row showed.',
    },
    {
      column: commerceRelationships.productFamilyId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'relationship_endpoint',
      activeStatusColumn: commerceRelationships.validTo,
      note: RELATIONSHIP_NOTE,
    },
  ],

  canonical_product: [
    flattenTarget(canonicalProducts.mergedIntoId),
    aliasTarget(canonicalProductAliases.productId, canonicalProductAliases.normalizedAlias),
    sourceLinkTarget(
      canonicalProductSourceLinks.productId,
      canonicalProductSourceLinks.sourceRecordId,
      canonicalProductSourceLinks.status,
    ),
    ...redirectHistoryTargets(canonicalProductRedirects.fromId, canonicalProductRedirects.toId),
    {
      column: canonicalVariants.productId,
      phase: 'children',
      disposition: 'conflict_gated',
      conflictKind: 'variant_signature',
      uniqueWith: [canonicalVariants.signature],
      note:
        '`canonical_variants_product_signature_key` and `..._default_key` both span this ' +
        'column. Two variants carrying one signature must themselves be merged — keeping one ' +
        "would strand the other's offers on a row nothing links to — so the planning phase " +
        'raises the conflict and only `merge_pair` resolves it. The guard is still needed AFTER ' +
        'that resolution: the merged variant keeps its own signature as a TOMBSTONE under the ' +
        'losing product, and moving it would collide with the winner it now points at. The ' +
        'tombstone stays where it is and `merged_into_id` is what resolves.',
    },
    {
      column: productIdentifiers.productId,
      phase: 'identifiers',
      disposition: 'conflict_gated',
      conflictKind: 'identifier',
      activeStatusColumn: productIdentifiers.status,
      activeStatusValue: 'active',
      note: IDENTIFIER_NOTE,
    },
    {
      column: canonicalImages.productId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalImages.imageRef],
      note:
        'Imagery follows the surviving product, minus anything it already shows — the unique is ' +
        'on the generated `image_ref`, so the same asset arriving from two sources converges.',
    },
    {
      column: canonicalAttributeValues.productId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        canonicalAttributeValues.attributeKey,
        canonicalAttributeValues.sourceRecordId,
        canonicalAttributeValues.valueSlot,
      ],
      note:
        'Source FACTS about the product follow it, so a merge never loses what a source said. ' +
        'The convergence unique is per (entity, key, observation, slot), so re-stating one ' +
        'observation on the winner is a no-op rather than a duplicate.',
    },
    {
      column: canonicalFieldProvenance.productId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalFieldProvenance.field],
      note: 'One explanation per selected field. See the family entry.',
    },
    {
      column: reviews.canonicalProductId,
      phase: 'reviews',
      disposition: 'repoint',
      note:
        "A product review is about the MODEL (#76's `product` scope), so it follows the " +
        'surviving model. The aggregate is rebuilt, never summed.',
    },
    {
      column: reviewEligibilities.canonicalProductId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [reviewEligibilities.orderItemId, reviewEligibilities.oxyUserId, reviewEligibilities.scope],
      note: 'See the merchant entry — one right to review per order line, per person, per scope.',
    },
    {
      column: reviewAggregates.canonicalProductId,
      phase: 'reviews',
      disposition: 'retained_by_tombstone',
      note: "The loser's projection describes the loser. See the merchant entry.",
    },
    {
      column: matchDecisions.matchedCanonicalProductId,
      phase: 'reviews',
      disposition: 'repoint',
      note: MATCH_HISTORY_NOTE,
    },
    {
      column: matchDecisionCandidates.canonicalProductId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [matchDecisionCandidates.decisionId],
      note:
        'A candidate the pipeline considered. `(decision_id, rank)` is unique and the winner may ' +
        'already be a candidate of the same decision, in which case the loser\'s row stays as ' +
        'the record that both were weighed.',
    },
    {
      column: matchBlockedPairs.targetCanonicalProductId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [matchBlockedPairs.subjectKey],
      note:
        '"Rejected pairs stay rejected" (#58 acceptance 4) must survive a merge, or the merge ' +
        'itself becomes a way to clear a block. The open-block unique is on ' +
        '(subject_key, target_key), so a block the winner already carries stays.',
    },
    {
      column: procurementOffers.canonicalProductId,
      phase: 'offers',
      disposition: 'repoint',
      note: "#118's supplier offer mapping. It names what Mercaria can buy, and that follows the surviving product.",
    },
    {
      column: retailComplianceEvidence.canonicalProductId,
      phase: 'offers',
      disposition: 'repoint',
      note: COMPLIANCE_NOTE,
    },
    {
      column: retailSuppressions.canonicalProductId,
      phase: 'offers',
      disposition: 'repoint_if_absent',
      uniqueWith: [retailSuppressions.scope, retailSuppressions.kind],
      alsoSetColumns: [retailSuppressions.scopeRef],
      guardWhereNullColumn: retailSuppressions.liftedAt,
      note: SUPPRESSION_NOTE,
    },
    {
      column: catalogBackfillRecords.canonicalProductId,
      phase: 'reviews',
      disposition: 'retained_by_tombstone',
      note: BACKFILL_RECORD_NOTE,
    },
    {
      column: productSaves.canonicalProductId,
      phase: 'saves',
      disposition: 'repoint_if_absent',
      uniqueWith: [productSaves.oxyUserId],
      note: PRODUCT_SAVE_NOTE,
    },
    {
      column: productSaveAggregates.canonicalProductId,
      phase: 'saves',
      disposition: 'retained_by_tombstone',
      note: PRODUCT_SAVE_AGGREGATE_NOTE,
    },
    {
      column: offerPriceSeries.canonicalProductId,
      phase: 'offers',
      disposition: 'retained_by_tombstone',
      note: PRICE_SERIES_NOTE,
    },
  ],

  canonical_variant: [
    flattenTarget(canonicalVariants.mergedIntoId),
    aliasTarget(canonicalVariantAliases.variantId, canonicalVariantAliases.normalizedAlias),
    sourceLinkTarget(
      canonicalVariantSourceLinks.variantId,
      canonicalVariantSourceLinks.sourceRecordId,
      canonicalVariantSourceLinks.status,
    ),
    {
      column: canonicalVariantAttributes.variantId,
      phase: 'children',
      disposition: 'retained_by_tombstone',
      note:
        'The option assignments that DEFINE a variant. Two variants merge only when they are ' +
        "the same configuration, so the winner's axes already say what the loser's said — and " +
        '`canonical_variant_attrs_key_unique` would refuse the copy anyway. The tombstone keeps ' +
        'its own, which is what makes the merge auditable afterwards.',
    },
    {
      column: productIdentifiers.variantId,
      phase: 'identifiers',
      disposition: 'conflict_gated',
      conflictKind: 'identifier',
      activeStatusColumn: productIdentifiers.status,
      activeStatusValue: 'active',
      note: IDENTIFIER_NOTE,
    },
    {
      column: canonicalImages.variantId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalImages.imageRef],
      note: 'See the product entry.',
    },
    {
      column: canonicalAttributeValues.variantId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        canonicalAttributeValues.attributeKey,
        canonicalAttributeValues.sourceRecordId,
        canonicalAttributeValues.valueSlot,
      ],
      note: 'See the product entry.',
    },
    {
      column: canonicalFieldProvenance.variantId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalFieldProvenance.field],
      note: 'One explanation per selected field. See the family entry.',
    },
    {
      column: bundleComponents.bundleVariantId,
      phase: 'children',
      disposition: 'repoint_if_absent',
      uniqueWith: [bundleComponents.componentVariantId],
      note:
        'What this bundle contains. `(bundle, component)` is unique, so a component the winner ' +
        'already lists stays behind rather than duplicating the bundle.',
    },
    {
      column: bundleComponents.componentVariantId,
      phase: 'children',
      disposition: 'repoint_if_absent',
      uniqueWith: [bundleComponents.bundleVariantId],
      note:
        'Which bundles contain this variant — the other side of the same unique, and it must ' +
        'move too or a bundle would claim to contain a tombstone.',
    },
    {
      column: offers.canonicalVariantId,
      phase: 'offers',
      disposition: 'conflict_gated',
      conflictKind: 'active_offer',
      activeStatusColumn: offers.status,
      activeStatusValue: 'active',
      note: OFFER_NOTE,
    },
    {
      column: nativeListingLinks.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint',
      note:
        "#57's attachment of a native listing to a canonical variant. Its active unique is on " +
        'the NATIVE variant, not on this column, so two attachments landing on one canonical ' +
        'variant is the ordinary case — forty listings of one phone.',
    },
    {
      column: storeLinkageOfferOverlaps.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint',
      note: "#84's overlap evidence follows the variant it is about.",
    },
    {
      column: procurementOffers.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint',
      note: 'See the product entry.',
    },
    {
      column: matchDecisions.matchedCanonicalVariantId,
      phase: 'reviews',
      disposition: 'repoint',
      note: MATCH_HISTORY_NOTE,
    },
    {
      column: matchDecisionCandidates.canonicalVariantId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [matchDecisionCandidates.decisionId],
      note: 'See the product entry.',
    },
    {
      column: matchBlockedPairs.targetCanonicalVariantId,
      phase: 'reviews',
      disposition: 'repoint_if_absent',
      uniqueWith: [matchBlockedPairs.subjectKey],
      note: 'See the product entry — a merge must not become a way to clear a rejection.',
    },
    {
      column: retailComplianceEvidence.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint',
      note: COMPLIANCE_NOTE,
    },
    {
      column: retailEligibilityExceptions.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint',
      note:
        "#121's operator waiver, scoped to one variant. It follows the surviving identity because " +
        'after a merge that IS the same variant — and a waiver stranded on a tombstone would stop ' +
        'applying silently, which reads to an operator as their approved exception being ignored. ' +
        'Nothing about what may be waived changes: `waived_reasons` is CHECK-restricted to the ' +
        'waivable tuple, so moving a row can never widen it.',
    },
    {
      column: retailSuppressions.canonicalVariantId,
      phase: 'offers',
      disposition: 'repoint_if_absent',
      uniqueWith: [retailSuppressions.scope, retailSuppressions.kind],
      alsoSetColumns: [retailSuppressions.scopeRef],
      guardWhereNullColumn: retailSuppressions.liftedAt,
      note: SUPPRESSION_NOTE,
    },
    {
      column: catalogBackfillRecords.canonicalVariantId,
      phase: 'reviews',
      disposition: 'retained_by_tombstone',
      note: BACKFILL_RECORD_NOTE,
    },
    {
      column: productSaves.preferredCanonicalVariantId,
      phase: 'saves',
      disposition: 'repoint',
      note:
        "#80's optional preferred CONFIGURATION on a product save. Unconditional: nothing is " +
        'unique on this column, and after a merge that IS the same configuration — a preference ' +
        'left on a tombstone would silently stop matching any offer and the buyer would be shown ' +
        'the wrong variant of a product they explicitly narrowed.',
    },
    {
      column: catalogMergeConflicts.loserVariantId,
      phase: 'children',
      disposition: 'untouched',
      note:
        'A conflict row is the RECORD of a collision between two specific rows, including this ' +
        'merge\'s own. Repointing it would rewrite the history of a decision an operator made, ' +
        'which is exactly what `catalog_revisions` and this table exist to prevent.',
    },
    {
      column: catalogMergeConflicts.winnerVariantId,
      phase: 'children',
      disposition: 'untouched',
      note: 'The other side of the same record. See above.',
    },
    {
      column: offerPriceSeries.canonicalVariantId,
      phase: 'offers',
      disposition: 'retained_by_tombstone',
      note: PRICE_SERIES_NOTE,
    },
  ],
};

/**
 * `"<table>.<column>"` in POSTGRES names — the census's comparison key.
 *
 * `sqlColumnName` rather than `column.name`, because this schema sets its casing
 * on the drizzle instance: `column.name` is the TypeScript key, so a key built
 * from it reads `canonicalProductId` where the database and every migration read
 * `canonical_product_id`. Both sides of a comparison would still agree — and a
 * census failure message would name a column nobody can grep for.
 */
export function rehomeTargetKey(column: AnyPgColumn): string {
  return `${getTableConfig(column.table).name}.${sqlColumnName(column)}`;
}

/** Every target of one entity's plan that a given phase is responsible for. */
export function targetsForPhase(
  entityType: MergeableEntityType,
  phase: CatalogMergePhase,
): readonly RehomeTarget[] {
  return MERGE_REHOMING_PLAN[entityType].filter((target) => target.phase === phase);
}

/** Every conflict-gated target of one entity — what the planning phase probes. */
export function conflictTargets(entityType: MergeableEntityType): readonly RehomeTarget[] {
  return MERGE_REHOMING_PLAN[entityType].filter(
    (target) => target.disposition === 'conflict_gated',
  );
}
