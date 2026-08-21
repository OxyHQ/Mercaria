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
  canonicalProductFamilyLocalizations,
  canonicalProductLocalizations,
} from '../../db/schema/catalogLocalization.js';
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
import { channelOnboardingSessions } from '../../db/schema/channels.js';
import { reviewAggregates, reviewEligibilities, reviews } from '../../db/schema/reviews.js';
import { matchBlockedPairs, matchDecisionCandidates, matchDecisions } from '../../db/schema/matching.js';
import { procurementOffers, suppliers } from '../../db/schema/procurement.js';
import { catalogMergeConflicts } from '../../db/schema/curation.js';
import {
  automotiveFitments,
  compatibilityClaims,
  genericCompatibilityRelations,
} from '../../db/schema/compatibility.js';
import {
  retailComplianceEvidence,
  retailEligibilityExceptions,
  retailSuppressions,
} from '../../db/schema/retailEligibility.js';
import { catalogBackfillRecords } from '../../db/schema/backfill.js';
import { productSaveAggregates, productSaves } from '../../db/schema/productSaves.js';
import {
  priceAlertEvaluations,
  priceAlerts,
  priceAlertTriggers,
} from '../../db/schema/priceAlerts.js';
import { watchlistItems, watchlistSnapshotItems } from '../../db/schema/watchlists.js';
import { offerPriceSeries } from '../../db/schema/priceHistory.js';
import { priceSignalEvaluations, priceSignalFeedback } from '../../db/schema/priceSignals.js';
import {
  merchantAcquisitionCandidates,
  merchantDemandProducts,
  merchantDemandSnapshots,
} from '../../db/schema/merchantDemand.js';
import { sellerDraftMatchAssertions, sellerListingDrafts } from '../../db/schema/sellYours.js';
import {
  catalogSourceConfigs,
  marketplaceSellerIdentities,
} from '../../db/schema/ingestion.js';
import { locationPublications } from '../../db/schema/pickup.js';
import {
  shoppingAgentFindingLines,
  shoppingAgentLines,
  shoppingAgents,
  shoppingAgentTriggers,
} from '../../db/schema/shoppingAgents.js';
import { navigationSavedQueries } from '../../db/schema/navigation.js';
import { navigationNodes } from '../../db/schema/navigation.js';

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
 * - `conflict_gated` — a constraint the merge CANNOT resolve on its own, because
 *   what to do about it is a judgement. The planning phase raises a
 *   `catalog_merge_conflicts` row and the job blocks (#59 merge invariant 4).
 *   Usually that constraint is a unique and the judgement is which of two rows
 *   survives; on an entry carrying {@link RehomeTarget.distinctFromColumn} it is
 *   a distinct-endpoints CHECK and the judgement is about ONE row (#405). Such
 *   an entry still repoints every row that does NOT collapse, so it keeps its
 *   `uniqueWith` guard as well.
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
const PRICE_ALERT_NOTE =
  "#79's price alert — one buyer's own price condition. REPOINTED unconditionally: nothing is " +
  'unique on this column (a buyer legitimately holds "under 500 new" and "under 300 used" on one ' +
  'product), so there is no collision to guard against, and an alert left on a tombstone would ' +
  'watch a product no offer points at any more — it would simply stop notifying, silently, which ' +
  'is the failure a person notices only by the absence of something. The PROVENANCE stamp ' +
  '(`rehomed_from_canonical_product_id`) is applied by the `alerts` phase runner before the ' +
  'generic move, because the rehomer sets a column to the WINNER and this one records the loser.';

const PRICE_ALERT_SPLIT_TARGET_NOTE =
  "The other candidate of a split #79's alert is still waiting on an answer about. Repointed for " +
  'the same reason the subject is: a buyer asked to choose between a product and a TOMBSTONE is ' +
  'being offered a dead identity, and the winner is what that candidate has become.';

/**
 * Both `reviews` entries, which are the same collision one scope apart (#333).
 *
 * `reviews_author_scope_target_key` is `(author_oxy_user_id, scope, target_key)`
 * WHERE the scope is not null, and `target_key` is a GENERATED column over the
 * six target columns — so ONE buyer who reviewed BOTH merged entities holds two
 * rows that become one key the moment the loser's is repointed. An unguarded
 * `repoint` raised 23505 and failed the phase.
 *
 * `[author_oxy_user_id, scope]` is EXACT rather than approximate at these two
 * scopes, and that is a property of `reviews_target_exclusivity_check` rather
 * than an assumption: a `product`-scoped row has `canonical_product_id` set and
 * every other target column NULL, so `target_key` is that id and five empty
 * strings. Guarding on the author and the scope therefore names precisely the
 * winner rows the index would collide with — no wider, which is the direction
 * `retail_suppressions` records as the dangerous one.
 */
const REVIEW_COLLISION_NOTE =
  "A buyer's review follows the entity it is about — except where that buyer already reviewed " +
  'the SURVIVOR, which the merge cannot merge into one rating and must not resolve by deleting ' +
  'or hiding either. The collision stays on the tombstone (`product_saves`, one domain over) and ' +
  "the merge RECORDS having left it there, in #76's own `review_target_migrations` under the " +
  '`rehome_merge` action it published for this. The aggregates stay derivable both sides: ' +
  '`review_aggregates` is a PROJECTION and `rollups` re-derives the tombstone as well as the ' +
  'winner, so the retained rating still counts for the identity it was written about.';

const PRICE_ALERT_TRIGGER_NOTE =
  "#79's trigger — the immutable RECORD that one offer crossed one buyer's target at one " +
  'observed price. RETAINED by the tombstone, the `catalog_backfill_records` disposition and its ' +
  'reasoning: repointing it would rewrite what was actually observed, and the trigger names the ' +
  'OFFER and the observation as well, neither of which a product merge touches. Its foreign keys ' +
  'are RESTRICT and a tombstone is a live row, so nothing is orphaned.';

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
  /**
   * The OTHER end of a relation this column must never be made equal to (#405).
   *
   * A merge can land both ends of one row on the winner —
   * `generic_compatibility_relations_distinct_endpoints_check` then refuses the
   * repoint with `23514`, mid-phase. `absenceGuard` cannot see it: that guard
   * hunts a COLLIDING WINNER ROW and here there is none. The row is legal before
   * the merge and illegal after it.
   *
   * So the executor skips such a row, and the `plan` phase raises the conflict
   * that makes leaving it a DECISION rather than a silent omission — an OPEN
   * relation left behind on a tombstone still claims compatibility for a dead
   * identity, which is exactly the thing #59 merge invariant 4 refuses to do
   * without a person. The skip is deliberately WIDER than the probe: it covers
   * closed rows too (the CHECK is not partial, so they would raise `23514` just
   * the same), while the probe raises a conflict only for OPEN ones, because a
   * closed relation is already history and staying with the tombstone is what
   * `retained_by_tombstone` means.
   */
  readonly distinctFromColumn?: AnyPgColumn;
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
      disposition: 'conflict_gated',
      conflictKind: 'redirect_endpoint_collapse',
      uniqueWith: [fromColumn],
      distinctFromColumn: fromColumn,
      note:
        'A hop INTO the loser must follow the flattening, or an old URL resolves to a ' +
        'tombstone. `(from_id, to_id)` is unique, so a hop the winner already records stays. ' +
        'And a hop the WINNER already made INTO the loser would become a self-redirect, which ' +
        '`..._self_check` refuses with 23514 (#405) -- reachable without any race, because ' +
        "#59 acceptance 2's `revive_tombstone` brings an entity back while deliberately leaving " +
        'its redirect rows standing, so a revived entity is a legal winner still naming the ' +
        'loser. That row is TRUE history and stays where it is; the operator records it.',
    },
  ];
}


const COMPATIBILITY_RELATION_NOTE =
  "A compatibility claim's endpoint (#367 step 8, ADR 0007 D8). " +
  '`generic_compatibility_relations_open_key` holds one OPEN relation per (kind, endpoints), so a ' +
  'claim the winner already carries stays on the tombstone rather than colliding -- nothing is ' +
  'lost, because the winner already answers it. The guard names the SEVEN RAW components of ' +
  '`relation_key` and NEVER the generated column itself: the key CONTAINS the id being moved, so ' +
  'comparing a pre-move key against the winner can never match and the guard would be VACUOUS. ' +
  'Measured -- the generated-column spelling raises 23505 and fails the phase.';

const COMPATIBILITY_FITMENT_NOTE =
  'A fitment names the part, and the part is what a merge moves. ' +
  '`automotive_fitments_open_key` holds one OPEN fitment per (subject, vehicle target, position), ' +
  'so a statement the winner already carries stays on the tombstone. The guard names the SIX RAW ' +
  'components of `fitment_key` for the reason the relation note gives. The vehicle columns are NOT ' +
  'part of this merge: a vehicle record is reference data with its own identity.';

const COMPATIBILITY_CLAIM_NOTE =
  'What a SOURCE said about a specific identity, kept verbatim (ADR 0007 D7). Retained by the ' +
  'tombstone: repointing would rewrite the observation into a claim about an entity the source ' +
  'never named, which is the one thing the claim layer exists to prevent. ' +
  '`mercaria_compatibility_claims_raw_freeze` refuses the UPDATE outright, so a `repoint` here ' +
  'fails the phase rather than corrupting the record. Both foreign keys are RESTRICT and a ' +
  'tombstone is a live row, so nothing is orphaned, and the SELECTED canonical fact still follows ' +
  'the winner through the relation and fitment entries.';

const COMPATIBILITY_BOTH_ENDS_NOTE =
  ' A merge can collapse BOTH ends of one relation -- subject and target both becoming the ' +
  'winner, which `generic_compatibility_relations_distinct_endpoints_check` refuses with 23514. ' +
  'No `uniqueWith` can express "skip this row because the other endpoint is also moving", because ' +
  '`absenceGuard` hunts a colliding WINNER row and a collapse has none; `distinctFromColumn` is ' +
  'that case (#405), and it is gated rather than skipped silently because an OPEN relation left ' +
  'on a tombstone still claims compatibility for a dead identity.';

const BUNDLE_COLLAPSE_NOTE =
  ' A merge can also make the two ends EQUAL -- a bundle containing the very variant it is ' +
  'being merged with -- which `bundle_components_self_check` refuses with 23514 (#405). ' +
  'Deliberately NO `distinctFromColumn`: a guard would skip the row and leave the WINNER\'s ' +
  'bundle listing a tombstone, silently. The conflict blocks instead, the operator removes the ' +
  'component through the catalogue\'s own writer, and `resolveMergeConflict` refuses the ' +
  'decision until they have -- so by the time the phase runs there is nothing left to collide. ' +
  'If somebody re-adds it in that window the repoint raises 23514 and the phase blocks, which ' +
  'is the loud failure and the right one.';

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

const CANONICAL_LOCALIZATION_NOTE =
  "#367 L2's localized presentation of this entity. It follows the winner, minus any locale the " +
  'winner already has: the guard is exactly this table\'s own ' +
  '`_locale_key` unique, so a loser-side Spanish name whose twin already exists stays on the ' +
  'tombstone rather than aborting the phase — the `product_saves` and `canonical_images` shape. ' +
  'What it deliberately does NOT do is mark the carried rows `stale`. That is a real and stated ' +
  'cost: a merged product\'s Spanish name may now describe the loser, and no automatic rule can ' +
  'tell whether it still describes the winner. Marking every carried row stale would flood a ' +
  'translation desk after any merge and train it to clear the flag without reading; leaving them ' +
  'settled means a wrong name can survive a merge. The desk surfaces the merge through ' +
  '`catalog_localization_revisions`, and an operator who merges two products with divergent copy ' +
  'is the one who knows which name won.';

const PRODUCT_SAVE_NOTE =
  "#80's canonical product save — a person's standing interest in this product, and #80 " +
  'migration rule 7 requires a merge to rehome it automatically. The guard is exactly ' +
  '`product_saves_oxy_user_id_canonical_product_id_key`: a buyer who saved BOTH sides already ' +
  'has a save on the winner, so their loser-side row stays on the tombstone and the saved-items ' +
  'read excludes a merged product — which loses nothing precisely BECAUSE the twin exists, and ' +
  'is the only reading under which that exclusion is safe. Repointing it instead would violate ' +
  'the unique and abort the phase.';

const WATCHLIST_ITEM_NOTE =
  "#81's watchlist entry — a person's declared intention to buy this product, in a list with a " +
  'purpose. #81 correction rule 1 requires a merge to rehome it idempotently, and the guard is ' +
  'exactly `watchlist_items_watchlist_id_canonical_product_id_key`: a list holding BOTH sides of ' +
  'a merge already has an entry for the winner, so the loser-side row stays on the tombstone ' +
  'rather than aborting the phase. That is not a silent loss — the basket evaluation derives ' +
  '`product_merged_into_existing_item` for it and excludes it from the total, so the buyer is ' +
  'told to remove a duplicate rather than being charged for one product twice. Merging the two ' +
  "rows' QUANTITIES instead was refused: a merge changing how many of something somebody asked " +
  'for is a decision about their money that no automatic rule may make.';

const WATCHLIST_SNAPSHOT_LINE_NOTE =
  "#81's recorded evaluation of one item, at one moment. It is HISTORY and stays with the " +
  'entity it measured: repointing it would rewrite what a buyer was shown, which is the same ' +
  'objection `catalog_backfill_records` and the curation timeline already carry. The reader ' +
  'still resolves the product through `merged_into_id`, one hop by construction (ADR 0002 D16), ' +
  'and the line carries its own amounts and quote so it reads completely without any of them.';

const SELL_YOURS_DRAFT_NOTE =
  "#91's in-flight `Sell yours` draft, which POINTS at the product a seller says they are " +
  'selling and copies nothing from it. Repointed unconditionally: after a merge that IS the ' +
  'same product, and a draft left on a tombstone would publish an attachment to a dead ' +
  'identity — the listing would appear on no product page and the seller would have no way ' +
  'to tell why. Nothing is unique on either column, and the accompanying `match_state` is ' +
  'unaffected: what the seller decided about the product does not change when two rows ' +
  'describing that product become one.';

const SELL_YOURS_ASSERTION_NOTE =
  "#91's append-only record of what a seller declared, confirmed, rejected or had refused. " +
  'It stays with the tombstone, and the table could not be repointed even if that were the ' +
  'right answer — it refuses UPDATE by trigger. That is the same reasoning as ' +
  '`catalog_merge_conflicts` above: an assertion is the history of a statement a person made ' +
  'about a specific row at a specific time, and rewriting it to be about the surviving row ' +
  'would make the one question this table exists to answer — why is this listing attached to ' +
  'that product — unanswerable afterwards. The DRAFT is repointed, so the seller\'s live ' +
  'intent follows the merge while the trail of how it got there does not move.';

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

const SHOPPING_AGENT_LINE_PRODUCT_NOTE =
  "#97's agent LINE — one thing a shopper's standing instruction watches. REPOINTED " +
  'unconditionally: nothing is unique on this column (`shopping_agent_lines_position_key` spans ' +
  '(agent, position) and the fan-out index is deliberately not unique), so there is no collision ' +
  'to guard against. The failure it prevents is the quietest one in the domain — a line left on a ' +
  'tombstone matches no offer, so the agent goes on evaluating and never qualifies, and the ' +
  'shopper is told nothing at all. "Nothing qualified" is exactly what a CORRECT evaluation of a ' +
  'product nobody sells looks like, so the silence is indistinguishable from an agent that is ' +
  'working, and the only person who could notice is the one who stopped hearing from it.';

const SHOPPING_AGENT_LINE_VARIANT_NOTE =
  "#97's optional exact CONFIGURATION on an agent line — the `price_alerts` and `product_saves` " +
  'disposition, for their reason. Unconditional: nothing is unique on this column, and after a ' +
  'merge that IS the same configuration. Narrowed to a tombstone variant the line would match no ' +
  'offer and the objective would become permanently unsatisfiable, with the agent still enabled ' +
  'and still reporting that it ran.';

const SHOPPING_AGENT_LINE_MERCHANT_NOTE =
  "#97's optional merchant NARROWING on an agent line. Unconditional, for the reason the " +
  'saved-product preference and the alert scope beside it are: a shopper who narrowed a line to a ' +
  'merchant meant the BUSINESS, which after a merge trades under the surviving identity. Left on ' +
  'a tombstone the narrowing would match no offer, and the agent would evaluate on its own ' +
  'schedule forever without ever qualifying.';

const SHOPPING_AGENT_SPLIT_TARGET_NOTE =
  "The other candidate of a split #97's agent is still waiting on an answer about — " +
  '`price_alerts.split_target_canonical_product_id` exactly, and repointed for its reason: a ' +
  'shopper asked to choose between a product and a TOMBSTONE is being offered a dead identity, ' +
  'and the winner is what that candidate has become.';

const SHOPPING_AGENT_TRIGGER_NOTE =
  "#97's fan-out QUEUE row — one standing request to look at ONE canonical product, and " +
  '`shopping_agent_triggers_subject_key` is UNIQUE on this column. RETAINED by the tombstone, the ' +
  '`price_alert_evaluations` disposition for its reason: repointing it would collide with the ' +
  "winner's own row outright, and it would say nothing the winner does not already have. Leaving " +
  'it costs one claim that fans out to zero agents — after this phase the loser has no lines — ' +
  'and then reads `done` forever. What the WINNER needs is a FRESH request, and the `agents` ' +
  "phase runner enqueues one after the move rather than trying to carry the loser's across.";

const SHOPPING_AGENT_FINDING_LINE_NOTE =
  "#97's finding LINE — the immutable record of what one plan selected about THIS product at one " +
  'moment, under a named policy version and a named input digest. RETAINED by the tombstone, the ' +
  '`price_alert_triggers` disposition and its reasoning: a finding is what was OBSERVED, and ' +
  'repointing it would rewrite the observation to be about a product the plan never priced — ' +
  'which is also why the table refuses UPDATE by trigger, so the move could not land even if it ' +
  'were the right answer. Its foreign key is RESTRICT and a tombstone is a live row, so nothing ' +
  'is orphaned, and a reader still resolves the product through `merged_into_id`, which is one ' +
  'hop by construction (ADR 0002 D16).';

/**
 * The plan, per mergeable entity.
 *
 * `Record<MergeableEntityType, …>` so a type added without a plan is a compile
 * error, and the census then checks each plan against the schema.
 */
/**
 * #367 step 7's navigation nodes, on both mergeable entities they can point at.
 *
 * `untouched`, and it is the ONE disposition compatible with the domain's own
 * shape rather than a preference. A PUBLISHED navigation tree is frozen by
 * trigger — `mercaria_navigation_published_nodes_frozen` permits nothing but a
 * node's `visibility` — so a repoint would RAISE on exactly the trees that are
 * live, which is the failure mode a merge must not have. Nor is it merely
 * blocked: a menu is what shoppers were SHOWN under a version somebody
 * published, and rewriting one in place is what publication versioning exists to
 * prevent.
 *
 * Nothing dangles and nothing renders wrong. A merge TOMBSTONES the loser rather
 * than deleting it, so the `restrict` foreign key is never violated; and the
 * public read resolves a node's target live, admitting only an active, unmerged
 * row, so a node pointing at a merged brand or family is WITHHELD with
 * `target_not_publicly_visible` rather than leading anywhere. The menu loses an
 * entry and gains nothing false.
 *
 * The correction is a new tree version — an editorial act with an author, which
 * is what changing any other menu entry already is.
 */
const NAVIGATION_NODE_NOTE =
  "#367's navigation nodes are presentation, and a published tree is frozen by trigger — a " +
  'repoint would raise on every live menu. A merge tombstones rather than deletes, so the ' +
  'restrict foreign key holds, and the public read admits only an active, unmerged target, so ' +
  'a node pointing at the loser is WITHHELD rather than leading to a tombstone. The correction ' +
  'is a new tree version, which is an editorial act with an author.';

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
      column: navigationNodes.brandId,
      phase: 'children',
      disposition: 'untouched',
      note: NAVIGATION_NODE_NOTE,
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
    {
      column: merchantDemandSnapshots.merchantId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A REPORTING SNAPSHOT of what demand was for that identity in a stated window, under ' +
        'stated policy versions (#86). Retained by the tombstone for the reason a superseded ' +
        'snapshot is kept at all: it is what a merchant was SHOWN, and repointing it would ' +
        'attribute one identity’s demand to another retrospectively — while its ' +
        '`..._live_key` partial unique on (merchant, market, window) would collide the moment ' +
        'both sides had a snapshot for the same period. The winner’s next build measures the ' +
        'merged catalogue, which is the correct answer going forward and is a NEW snapshot.',
    },
    {
      column: merchantAcquisitionCandidates.merchantId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'One merchant’s standing in the acquisition pipeline (#86), with its outreach log and ' +
        'its audit trail hanging off it. Retained: `(merchant_id)` is UNIQUE, so two candidates ' +
        'cannot become one without deciding whose exclusion, whose do-not-contact request and ' +
        'whose assignment survives — and a do-not-contact request is exactly the fact a merge ' +
        'must never silently drop. The winner is enrolled afresh by the operator surface, and ' +
        'both trails stay readable under the ids somebody acted on.',
    },
    {
      column: priceSignalFeedback.merchantId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A correction report a merchant filed against a claim Mercaria PUBLISHED concerning that ' +
        'identity (#82 monitoring 4). Retained by the tombstone for the same reason the ' +
        'evaluations are: the report is evidence about a signal that WAS shown, and repointing it ' +
        'would file a complaint against a product nobody complained about. It also keeps the ' +
        '`..._open_key` partial unique out of the merge entirely, which is the collision this ' +
        'disposition avoids rather than resolves.',
    },
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
      column: channelOnboardingSessions.merchantId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "#87's connection wizard records the merchant it bound to when it opened. It follows " +
        'the survivor unconditionally: nothing is unique on the column, and a LIVE session left ' +
        'on a tombstone would show a merchant that no longer exists and reconcile against a ' +
        'catalogue nobody can reach. A finished session repoints too — it is operational state ' +
        'nothing cites as evidence, so preserving the pre-merge id would buy no audit value and ' +
        'cost the same broken read on a resume.',
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
      disposition: 'repoint_if_absent',
      uniqueWith: [reviews.authorOxyUserId, reviews.scope],
      note: REVIEW_COLLISION_NOTE,
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
    {
      column: priceAlerts.merchantId,
      phase: 'alerts',
      disposition: 'repoint',
      note:
        "#79's optional merchant SCOPE on a price alert. Unconditional, for the reason the " +
        'saved-product preference beside it is: a buyer who narrowed an alert to a merchant meant ' +
        'the business, which after a merge trades under the surviving identity — and left on a ' +
        'tombstone the scope would match no offer and the alert would silently never fire.',
    },
    {
      column: priceAlertTriggers.merchantId,
      phase: 'alerts',
      disposition: 'retained_by_tombstone',
      note: PRICE_ALERT_TRIGGER_NOTE,
    },
    {
      column: watchlistItems.preferredMerchantId,
      phase: 'saves',
      disposition: 'repoint',
      note:
        "#81's optional preferred SELLER on a watchlist entry. The `product_saves` disposition " +
        'for its reason, with one of its own: a preference stranded on a tombstone matches no ' +
        'offer, and an item that matches no offer leaves the basket total — so the failure ' +
        'shows up as a number quietly going down rather than as anything anybody would look at.',
    },
    {
      column: shoppingAgentLines.merchantId,
      phase: 'agents',
      disposition: 'repoint',
      note: SHOPPING_AGENT_LINE_MERCHANT_NOTE,
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
    {
      column: priceAlerts.storefrontId,
      phase: 'alerts',
      disposition: 'repoint',
      note:
        "#79's optional channel SCOPE on a price alert — the merchant scope one join over, and " +
        'the same decision: a scope left on a tombstoned storefront matches no offer, so the ' +
        'alert stops firing without ever saying it has.',
    },
    {
      column: channelOnboardingSessions.storefrontId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "#87's connection wizard, the channel half. It moves WITH the merchant column above — " +
        'the pair names one binding, and repointing one without the other would leave a session ' +
        'claiming a storefront that belongs to a different merchant.',
    },
    {
      column: locationPublications.storefrontId,
      phase: 'children',
      disposition: 'repoint',
      note:
        "#93's shop front, pointed at the CHANNEL it is a branch of. It follows the survivor " +
        'for the `catalog_source_configs` reason one entry up: a published location naming a ' +
        'tombstoned storefront would keep appearing in nearby results with a channel card ' +
        'nobody can open. No unique spans it, and the column is nullable — a merchant who never ' +
        'named a storefront is unaffected either way. Note what is NOT here: the MERCHANT half ' +
        "of #93 publication field 2 is not a column at all — #84's `native_store_links` answers " +
        'it, so a merchant merge rehomes it through that table and never through this one.',
    },
  ],

  canonical_product_family: [
    {
      column: canonicalProductFamilyLocalizations.canonicalProductFamilyId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalProductFamilyLocalizations.locale],
      note: CANONICAL_LOCALIZATION_NOTE,
    },
    {
      column: genericCompatibilityRelations.targetFamilyId,
      phase: 'relationships',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        genericCompatibilityRelations.kind,
        genericCompatibilityRelations.subjectProductId,
        genericCompatibilityRelations.subjectVariantId,
        genericCompatibilityRelations.targetProductId,
        genericCompatibilityRelations.targetVariantId,
        genericCompatibilityRelations.targetType,
        genericCompatibilityRelations.targetKey,
      ],
      guardWhereNullColumn: genericCompatibilityRelations.validTo,
      activeStatusColumn: genericCompatibilityRelations.validTo,
      note: COMPATIBILITY_RELATION_NOTE,
    },
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
      column: navigationNodes.productFamilyId,
      phase: 'children',
      disposition: 'untouched',
      note: NAVIGATION_NODE_NOTE,
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
    {
      column: genericCompatibilityRelations.subjectProductId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'compatibility_endpoint_collapse',
      distinctFromColumn: genericCompatibilityRelations.targetProductId,
      uniqueWith: [
        genericCompatibilityRelations.kind,
        genericCompatibilityRelations.subjectVariantId,
        genericCompatibilityRelations.targetFamilyId,
        genericCompatibilityRelations.targetProductId,
        genericCompatibilityRelations.targetVariantId,
        genericCompatibilityRelations.targetType,
        genericCompatibilityRelations.targetKey,
      ],
      guardWhereNullColumn: genericCompatibilityRelations.validTo,
      activeStatusColumn: genericCompatibilityRelations.validTo,
      note: COMPATIBILITY_RELATION_NOTE + COMPATIBILITY_BOTH_ENDS_NOTE,
    },
    {
      column: genericCompatibilityRelations.targetProductId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'compatibility_endpoint_collapse',
      distinctFromColumn: genericCompatibilityRelations.subjectProductId,
      uniqueWith: [
        genericCompatibilityRelations.kind,
        genericCompatibilityRelations.subjectProductId,
        genericCompatibilityRelations.subjectVariantId,
        genericCompatibilityRelations.targetFamilyId,
        genericCompatibilityRelations.targetVariantId,
        genericCompatibilityRelations.targetType,
        genericCompatibilityRelations.targetKey,
      ],
      guardWhereNullColumn: genericCompatibilityRelations.validTo,
      activeStatusColumn: genericCompatibilityRelations.validTo,
      note: COMPATIBILITY_RELATION_NOTE + COMPATIBILITY_BOTH_ENDS_NOTE,
    },
    {
      column: automotiveFitments.subjectProductId,
      phase: 'relationships',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        automotiveFitments.subjectVariantId,
        automotiveFitments.vehicleMakeId,
        automotiveFitments.vehicleModelId,
        automotiveFitments.vehicleGenerationId,
        automotiveFitments.vehicleConfigurationId,
        automotiveFitments.position,
      ],
      guardWhereNullColumn: automotiveFitments.validTo,
      activeStatusColumn: automotiveFitments.validTo,
      note: COMPATIBILITY_FITMENT_NOTE,
    },
    {
      column: compatibilityClaims.subjectProductId,
      phase: 'relationships',
      disposition: 'retained_by_tombstone',
      note: COMPATIBILITY_CLAIM_NOTE,
    },
    {
      column: priceSignalEvaluations.canonicalProductId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A recorded measurement of what the prices of THIS identity looked like at a point in ' +
        'time, under a named policy version (#82). It stays with the tombstone for the ' +
        '`review_aggregates` reason plus one of its own: moving it would attribute measurements ' +
        'of one product to another, and the next sweep produces fresh rows for the merged ' +
        'catalogue under the winner — so nothing is lost and nothing is invented.',
    },
    {
      column: merchantDemandProducts.canonicalProductId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A product-level row INSIDE a merchant demand snapshot (#86), which is itself retained ' +
        'by the tombstone. Repointing it would move a row into a report it is not part of, and ' +
        'the snapshot’s coverage CHECK (`products_offered = disclosed + suppressed`) would then ' +
        'be false for both sides. Two snapshots cannot be concatenated for #78’s reason: each ' +
        'row’s counts are scoped to the merchant that owned the offers.',
    },
    {
      column: priceSignalFeedback.canonicalProductId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A correction report a merchant filed against a claim Mercaria PUBLISHED concerning that ' +
        'identity (#82 monitoring 4). Retained by the tombstone for the same reason the ' +
        'evaluations are: the report is evidence about a signal that WAS shown, and repointing it ' +
        'would file a complaint against a product nobody complained about. It also keeps the ' +
        '`..._open_key` partial unique out of the merge entirely, which is the collision this ' +
        'disposition avoids rather than resolves.',
    },
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
      column: canonicalProductLocalizations.canonicalProductId,
      phase: 'source_links',
      disposition: 'repoint_if_absent',
      uniqueWith: [canonicalProductLocalizations.locale],
      note: CANONICAL_LOCALIZATION_NOTE,
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
      disposition: 'repoint_if_absent',
      uniqueWith: [reviews.authorOxyUserId, reviews.scope],
      note: REVIEW_COLLISION_NOTE,
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
    {
      column: priceAlerts.canonicalProductId,
      phase: 'alerts',
      disposition: 'repoint',
      note: PRICE_ALERT_NOTE,
    },
    {
      column: priceAlerts.splitTargetCanonicalProductId,
      phase: 'alerts',
      disposition: 'repoint',
      note: PRICE_ALERT_SPLIT_TARGET_NOTE,
    },
    {
      column: priceAlertTriggers.canonicalProductId,
      phase: 'alerts',
      disposition: 'retained_by_tombstone',
      note: PRICE_ALERT_TRIGGER_NOTE,
    },
    {
      column: priceAlertEvaluations.canonicalProductId,
      phase: 'alerts',
      disposition: 'retained_by_tombstone',
      note:
        "#79's evaluation QUEUE is one row per subject, and this one is a standing request to " +
        'look at the LOSER. Repointing it would collide with the winner\'s own row (a unique ' +
        'spans the column) and would say nothing the winner does not already have; leaving it ' +
        'costs one claim that evaluates zero alerts — the loser has none after this phase — and ' +
        'then reads `done` forever. What the WINNER needs is a fresh request, and the phase ' +
        'runner enqueues one after the move rather than trying to carry the loser\'s across.',
    },
    {
      column: watchlistItems.canonicalProductId,
      phase: 'saves',
      disposition: 'repoint_if_absent',
      uniqueWith: [watchlistItems.watchlistId],
      note: WATCHLIST_ITEM_NOTE,
    },
    {
      column: watchlistSnapshotItems.canonicalProductId,
      phase: 'saves',
      disposition: 'untouched',
      note: WATCHLIST_SNAPSHOT_LINE_NOTE,
    },
    {
      column: sellerListingDrafts.canonicalProductId,
      phase: 'children',
      disposition: 'repoint',
      note: SELL_YOURS_DRAFT_NOTE,
    },
    {
      column: sellerDraftMatchAssertions.canonicalProductId,
      phase: 'children',
      disposition: 'retained_by_tombstone',
      note: SELL_YOURS_ASSERTION_NOTE,
    },
    {
      column: shoppingAgentLines.canonicalProductId,
      phase: 'agents',
      disposition: 'repoint',
      note: SHOPPING_AGENT_LINE_PRODUCT_NOTE,
    },
    {
      column: shoppingAgents.splitTargetCanonicalProductId,
      phase: 'agents',
      disposition: 'repoint',
      note: SHOPPING_AGENT_SPLIT_TARGET_NOTE,
    },
    {
      column: shoppingAgentTriggers.canonicalProductId,
      phase: 'agents',
      disposition: 'retained_by_tombstone',
      note: SHOPPING_AGENT_TRIGGER_NOTE,
    },
    {
      column: shoppingAgentFindingLines.canonicalProductId,
      phase: 'agents',
      disposition: 'retained_by_tombstone',
      note: SHOPPING_AGENT_FINDING_LINE_NOTE,
    },
  ],

  canonical_variant: [
    {
      column: genericCompatibilityRelations.subjectVariantId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'compatibility_endpoint_collapse',
      distinctFromColumn: genericCompatibilityRelations.targetVariantId,
      uniqueWith: [
        genericCompatibilityRelations.kind,
        genericCompatibilityRelations.subjectProductId,
        genericCompatibilityRelations.targetFamilyId,
        genericCompatibilityRelations.targetProductId,
        genericCompatibilityRelations.targetVariantId,
        genericCompatibilityRelations.targetType,
        genericCompatibilityRelations.targetKey,
      ],
      guardWhereNullColumn: genericCompatibilityRelations.validTo,
      activeStatusColumn: genericCompatibilityRelations.validTo,
      note: COMPATIBILITY_RELATION_NOTE + COMPATIBILITY_BOTH_ENDS_NOTE,
    },
    {
      column: genericCompatibilityRelations.targetVariantId,
      phase: 'relationships',
      disposition: 'conflict_gated',
      conflictKind: 'compatibility_endpoint_collapse',
      distinctFromColumn: genericCompatibilityRelations.subjectVariantId,
      uniqueWith: [
        genericCompatibilityRelations.kind,
        genericCompatibilityRelations.subjectProductId,
        genericCompatibilityRelations.subjectVariantId,
        genericCompatibilityRelations.targetFamilyId,
        genericCompatibilityRelations.targetProductId,
        genericCompatibilityRelations.targetType,
        genericCompatibilityRelations.targetKey,
      ],
      guardWhereNullColumn: genericCompatibilityRelations.validTo,
      activeStatusColumn: genericCompatibilityRelations.validTo,
      note: COMPATIBILITY_RELATION_NOTE + COMPATIBILITY_BOTH_ENDS_NOTE,
    },
    {
      column: automotiveFitments.subjectVariantId,
      phase: 'relationships',
      disposition: 'repoint_if_absent',
      uniqueWith: [
        automotiveFitments.subjectProductId,
        automotiveFitments.vehicleMakeId,
        automotiveFitments.vehicleModelId,
        automotiveFitments.vehicleGenerationId,
        automotiveFitments.vehicleConfigurationId,
        automotiveFitments.position,
      ],
      guardWhereNullColumn: automotiveFitments.validTo,
      activeStatusColumn: automotiveFitments.validTo,
      note: COMPATIBILITY_FITMENT_NOTE,
    },
    {
      column: compatibilityClaims.subjectVariantId,
      phase: 'relationships',
      disposition: 'retained_by_tombstone',
      note: COMPATIBILITY_CLAIM_NOTE,
    },
    {
      column: priceSignalEvaluations.canonicalVariantId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A recorded measurement of what the prices of THIS identity looked like at a point in ' +
        'time, under a named policy version (#82). It stays with the tombstone for the ' +
        '`review_aggregates` reason plus one of its own: moving it would attribute measurements ' +
        'of one product to another, and the next sweep produces fresh rows for the merged ' +
        'catalogue under the winner — so nothing is lost and nothing is invented.',
    },
    {
      column: priceSignalFeedback.canonicalVariantId,
      phase: 'rollups',
      disposition: 'retained_by_tombstone',
      note:
        'A correction report a merchant filed against a claim Mercaria PUBLISHED concerning that ' +
        'identity (#82 monitoring 4). Retained by the tombstone for the same reason the ' +
        'evaluations are: the report is evidence about a signal that WAS shown, and repointing it ' +
        'would file a complaint against a product nobody complained about. It also keeps the ' +
        '`..._open_key` partial unique out of the merge entirely, which is the collision this ' +
        'disposition avoids rather than resolves.',
    },
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
      disposition: 'conflict_gated',
      conflictKind: 'bundle_self_containment',
      uniqueWith: [bundleComponents.componentVariantId],
      note:
        'What this bundle contains. `(bundle, component)` is unique, so a component the winner ' +
        'already lists stays behind rather than duplicating the bundle.' + BUNDLE_COLLAPSE_NOTE,
    },
    {
      column: bundleComponents.componentVariantId,
      phase: 'children',
      disposition: 'conflict_gated',
      conflictKind: 'bundle_self_containment',
      uniqueWith: [bundleComponents.bundleVariantId],
      note:
        'Which bundles contain this variant — the other side of the same unique, and it must ' +
        'move too or a bundle would claim to contain a tombstone.' + BUNDLE_COLLAPSE_NOTE,
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
      column: priceAlerts.canonicalVariantId,
      phase: 'alerts',
      disposition: 'repoint',
      note:
        "#79's optional exact CONFIGURATION on a price alert. Unconditional, the saved-product " +
        'preference beside it exactly: after a merge that IS the same configuration, and an ' +
        'alert narrowed to a tombstone variant would match no offer and never fire again.',
    },
    {
      column: priceAlertTriggers.canonicalVariantId,
      phase: 'alerts',
      disposition: 'retained_by_tombstone',
      note: PRICE_ALERT_TRIGGER_NOTE,
    },
    {
      column: catalogMergeConflicts.collapsingBundleVariantId,
      phase: 'children',
      disposition: 'untouched',
      note:
        'The RECORD of a bundle self-containment an operator decided about (#405), named by the ' +
        'pair that identified the row. Untouched for the reason the conflict pair columns are: ' +
        'repointing it would rewrite the history of a decision — and this pair is the only ' +
        'surviving description of a component row the operator REMOVED before deciding.',
    },
    {
      column: catalogMergeConflicts.collapsingComponentVariantId,
      phase: 'children',
      disposition: 'untouched',
      note: 'The other half of that natural key. See above.',
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
    {
      column: watchlistItems.preferredCanonicalVariantId,
      phase: 'saves',
      disposition: 'repoint',
      note:
        "#81's optional preferred CONFIGURATION on a watchlist entry — `product_saves`' " +
        'disposition for its reason. Unconditional: nothing is unique on this column, and after ' +
        'a merge that IS the same configuration. Left on a tombstone the preference would stop ' +
        'matching any offer and the item would evaluate as `preferred_variant_retired` forever, ' +
        'silently dropping out of the basket total a buyer is watching.',
    },
    {
      column: watchlistSnapshotItems.preferredCanonicalVariantId,
      phase: 'saves',
      disposition: 'untouched',
      note: WATCHLIST_SNAPSHOT_LINE_NOTE,
    },
    {
      column: sellerListingDrafts.canonicalVariantId,
      phase: 'children',
      disposition: 'repoint',
      note: SELL_YOURS_DRAFT_NOTE,
    },
    {
      column: sellerDraftMatchAssertions.canonicalVariantId,
      phase: 'children',
      disposition: 'retained_by_tombstone',
      note: SELL_YOURS_ASSERTION_NOTE,
    },
    {
      column: shoppingAgentLines.canonicalVariantId,
      phase: 'agents',
      disposition: 'repoint',
      note: SHOPPING_AGENT_LINE_VARIANT_NOTE,
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

/**
 * Every ARRAY rehoming one entity's merge owes in one phase.
 *
 * Derived from `BARE_ENTITY_REFERENCES` rather than from a second list, so a
 * `rehomed` entry is executed BY BEING DECLARED — there is no way to declare one
 * the runner does not run, which is the failure this whole register exists to
 * catch. `verify` re-runs every one of these and requires zero rows, so each
 * statement has to be idempotent.
 */
export function bareArrayRehomesFor(
  entityType: MergeableEntityType,
  phase: CatalogMergePhase,
): readonly BareArrayRehome[] {
  return BARE_ENTITY_REFERENCES.filter(
    (entry) =>
      entry.disposition === 'rehomed' &&
      entry.rehome !== undefined &&
      entry.rehome.phase === phase &&
      (entry.targetEntities ?? []).includes(entityType),
  ).map((entry) => entry.rehome as BareArrayRehome);
}

/** Every conflict-gated target of one entity — what the planning phase probes. */
export function conflictTargets(entityType: MergeableEntityType): readonly RehomeTarget[] {
  return MERGE_REHOMING_PLAN[entityType].filter(
    (target) => target.disposition === 'conflict_gated',
  );
}

// ── The POLYMORPHIC register (#654) ────────────────────────────────────────

/**
 * What a merge does with a reference the FK census cannot see.
 *
 * ## The blind spot, and why a hand list of three would have re-created it
 *
 * `merge-plan-census.test.ts` derives its population by walking drizzle FOREIGN
 * KEYS. A polymorphic reference — an id column whose target TABLE is decided by
 * a sibling discriminator — has no foreign key to walk, because there is
 * nothing for one to point at. So the census cannot see it, and neither can the
 * gate that exists to make the census self-maintaining: for a polymorphic
 * reference it CANNOT FIRE. A future decision to rehome one arms an
 * endpoint-collapse hazard with the build staying green.
 *
 * #654 named three such tables. Measured against the schema, that list was
 * wrong in both directions, which is the whole argument for deriving rather
 * than listing:
 *
 * - A rule admitting only enums that are a SUBSET of `MERGEABLE_ENTITY_TYPES`
 *   MISSES `catalog_review_items`, whose `subject_type` is the wider
 *   `CURATION_SUBJECT_TYPES` — and with it every mixed vocabulary, which is
 *   where the review family lives.
 * - A rule admitting any enum that SHARES a value finds 38 tables, of which
 *   roughly a dozen hold a real bare polymorphic reference. Three was never the
 *   population.
 *
 * ## So the POPULATION is derived and only the DISPOSITION is declared
 *
 * `merge-plan-census.test.ts`'s own shape, one level up. The derivation is
 * deliberately OVER-WIDE, because the alternative is a rule that silently
 * omits, and omission is the failure this exists to prevent. The cost is that
 * `orders.source_channel` and `product_type_fields.flow` are in the population
 * on a coincidence of vocabulary. That is not noise to be filtered: it is a
 * line somebody ticks off ONCE so that the next one cannot arrive unnoticed.
 *
 * ## And #720: the vocabulary rule alone was defeated by a SYNONYM
 *
 * The original derivation was "an enum sharing a value with
 * `MERGEABLE_ENTITY_TYPES`", 39 tables. It cannot see a table that names the
 * same entities in different words — `attribute_value_reviews.entity_kind` and
 * `attribute_reindex_requests.entity_kind` are `['product', 'variant']` over a
 * canonical product and variant, zero intersection, absent from the population.
 * Two teams naming one entity differently is the normal case, so that miss was
 * a DEFAULT outcome, and it read as coverage: the table carries a real
 * discriminator with a real CHECK, so a reviewer checking "is this covered?"
 * sees one sitting there and stops.
 *
 * `polymorphic-entity-census.test.ts` therefore adds a SECOND derivation that
 * reads no vocabulary at all — a table carrying a closed value set beside a
 * bare reference the id ledger classifies outside
 * `FOREIGN_KEY_SPACE_ID_REASONS` — and the population is the union, 130 tables.
 * The 91 entries that arrived with it are mostly `not_an_entity_reference` and
 * `covered_by_bare_entity_census`, which is the point rather than a
 * disappointment: what the shape rule buys is that the NEXT synonym table fails
 * the build, and the ten shared reason constants below exist so that ninety-one
 * decisions did not become ninety-one restatements of ten.
 *
 * A table in the derived set with no entry here fails the build, and an entry
 * here whose table is no longer in the derived set fails it too — a stale
 * declaration is the exemption that can never fire, and this domain has paid
 * for one of those already.
 */
export type PolymorphicReferenceDisposition =
  /**
   * The enum shares a word with a mergeable entity type and NO column in this
   * table holds a mergeable entity id. Distinct from `untouched` on purpose:
   * this says the reference does not exist, that one says it exists and a merge
   * leaves it. Collapsing them loses the fact that somebody checked.
   */
  | 'not_an_entity_reference'
  /**
   * The enum says WHICH of several real foreign-key columns is populated, so
   * the reference itself is FK'd and `merge-plan-census.test.ts` already forces
   * a decision on it. Recorded rather than omitted, so the pairing is visible
   * to whoever reads either gate.
   */
  | 'discriminates_foreign_keys'
  /**
   * The table's bare reference is declared in {@link BARE_ENTITY_REFERENCES},
   * which owns the decision — `covered_by_polymorphic_census` pointing the
   * other way, so the pairing is visible from either gate (#720).
   *
   * This is a CITATION and it is VERIFIED rather than trusted:
   * `polymorphic-entity-census.test.ts` asserts every column named here really
   * appears in that register for this table, so an entry cannot defer to a
   * decision nobody made.
   */
  | 'covered_by_bare_entity_census'
  /** A real bare polymorphic reference that a merge deliberately does not move. */
  | 'untouched'
  /** A real bare polymorphic reference that a merge rehomes. */
  | 'rehomed';

export interface PolymorphicEntityReference {
  /** The POSTGRES table name, as the derivation reports it. */
  readonly table: string;
  readonly disposition: PolymorphicReferenceDisposition;
  /**
   * The id columns, required for `untouched`, `rehomed` and
   * `covered_by_bare_entity_census` and forbidden for the other two — an entry
   * claiming a merge leaves a reference alone has to say WHICH reference, or it
   * is a sentence rather than a decision.
   */
  readonly idColumns?: readonly string[];
  readonly reason: string;
}

// ── The shared reasons for #720's half of the population ────────────────────
//
// Written once each because they genuinely repeat: the derivation that survives
// a synonym admits every table holding a DOMESTIC ledgered bare id beside any
// discriminator, and those cluster into ten families. A bespoke sentence per
// table would be ten sentences restated ninety times, which is how a register
// stops being read.

/** A grouping token with no table anywhere — the commonest member by far. */
const CHECKOUT_GROUP_TOKEN =
  'The `checkout_group_id` grouping token (and the order/payment ids beside it). There is no ' +
  '`checkout_groups` table to point at, and a token is not an entity — nothing here names one ' +
  'of the seven, so a merge has nothing to move.';

/** A payment record naming a commerce record it does not compose with. */
const PAYMENT_COMMERCE_CORRELATION =
  'A financial record naming an order, a payment, a refund or a ledger transaction — and, where ' +
  'the table carries one, a polymorphic `owner_id` over a store, an Oxy account, a supplier or ' +
  'a referral partner. Every one is either a real row in this database that is NOT one of the ' +
  'seven (the seven are catalogue identities, and no merge touches an order) or an id in ' +
  'another system’s key space.';

/** Another system's key space, filed under a bespoke reason rather than a shared constant. */
const FOREIGN_KEY_SPACE_BESPOKE =
  "An id in another system's key space — a billing/payment provider object, an affiliate " +
  "network's transaction, eBay's marketplace, a supplier document, Moovo's transport request, " +
  'a connected platform record. In the population only because its ledger reason is written ' +
  'bespoke rather than with the shared constant; no merge in this database can act on one.';

/** A real polymorphic reference, every kind of which is outside the seven. */
const POLYMORPHIC_OUTSIDE_THE_SEVEN =
  'A genuine polymorphic reference whose discriminator tuple was read against ' +
  '`MERGEABLE_ENTITY_TYPES`: every kind it admits (a listing, a review, a seller, a store, a ' +
  'category, a product type, an attribute definition, a referral partner, a payout batch…) is ' +
  'outside the seven, so no merge reaches it. This is the disposition #720 exists to make ' +
  'somebody write down rather than infer from a vocabulary.';

/** The `provider_accounts` owner shape: a store id or an Oxy account id. */
const OWNER_STORE_OR_OXY_ACCOUNT =
  'The `provider_accounts.owner_id` shape — polymorphic by `owner_type` over a STORE id or an ' +
  'Oxy ACCOUNT id. A native store is not one of the seven (a MERCHANT is, and it is a ' +
  'different row), and the Oxy half is not in this database at all. Any provider-object id ' +
  'beside it is the provider’s own key space, which no merge here can act on either.';

/** A stable identity shared by that table's own version rows. */
const STABLE_IDENTITY_SAME_TABLE =
  'A stable identity naming a set of rows in THIS table rather than a row in another one — ' +
  "the `referral_programs.program_id` / `referral_reward_rules.rule_id` shape, whose parent " +
  'entity deliberately does not exist. Nothing outside the table is referenced, so nothing ' +
  'can be rehomed.';

/** Matches the id suffix and addresses no row anywhere. */
const NOT_A_ROW_ID_AT_ALL =
  'Matches the `_id` suffix by coincidence and addresses no row anywhere: a government tax ' +
  'registration number, a client-supplied device handle, a value this domain COMPOSES, or a ' +
  'closed adapter name CHECKed against a tuple in code.';

/** An Oxy media file id, filed bespoke rather than under the shared constant. */
const OXY_FILE_BESPOKE =
  'An Oxy STORAGE file id — the uploader owns the asset and this database has no table to ' +
  'reference. In the population only because the ledger states the evidence-is-declared ' +
  'posture in full rather than reusing the shared Oxy-file reason.';

/** A self- or circular reference drizzle-kit omits from the migration. */
const SELF_REFERENCE_DRIZZLE_OMITS =
  'A self- or circular reference into the SAME table, which drizzle-kit silently omits from ' +
  'both the migration and the snapshot. It names a row of its own kind, never one of the ' +
  'seven, so a merge has nothing to do with it.';

/** A real Mercaria row outside the seven. */
const MERCARIA_ROW_OUTSIDE_THE_SEVEN =
  'A real row in this database that is not one of the seven mergeable entities — an affiliate ' +
  "click, a source aggregate's own event, a shopping-agent line, a search query record. Read " +
  'against the schema, not assumed from the column name.';

/** The citation used by every `covered_by_bare_entity_census` entry. */
const BARE_CENSUS_OWNS_IT =
  'The bare references on this table are declared in `BARE_ENTITY_REFERENCES`, which records ' +
  'what a merge does with each of them (#695/#711). Recorded here so the pairing is visible ' +
  'from either gate, and the named columns are CHECKED against that register rather than ' +
  'trusted.';

/**
 * Every table the derivation finds, and what a merge does with it.
 *
 * Ordered as the derivation reports them (alphabetically by table), so a diff
 * that adds one lands next to its neighbours rather than at the end.
 */
export const POLYMORPHIC_ENTITY_REFERENCES: readonly PolymorphicEntityReference[] = [
  {
    table: 'abuse_reports',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'affiliate_outbound_clicks',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_variant_id', 'merchant_id', 'storefront_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'affiliate_transactions',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'analytics_events',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_product_id', 'canonical_variant_id', 'listing_id', 'merchant_id', 'offer_id', 'order_id', 'product_variant_id', 'store_id', 'storefront_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'analytics_rollups',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['merchant_id', 'store_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'analytics_search_queries',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['category_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'attribute_reindex_requests',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['entity_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'attribute_value_reviews',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['entity_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'automotive_fitments',
    disposition: 'not_an_entity_reference',
    reason:
      '`asserted_by_kind` names WHO asserted a fitment (manufacturer, catalog source, merchant, ' +
      'operator, matcher). `merchant` there is an actor role, not a `merchants.id`. The real ' +
      'subject reference is `subject_product_id`/`subject_variant_id`, both FK.',
  },
  {
    table: 'awin_advertisers',
    disposition: 'not_an_entity_reference',
    reason: SELF_REFERENCE_DRIZZLE_OMITS,
  },
  {
    table: 'billing_customers',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'catalog_authoring_draft_values',
    disposition: 'untouched',
    idColumns: ['canonical_ref_id'],
    reason:
      'A real bare reference: `canonical_ref_kind` over product/variant/family/brand with ' +
      '`canonical_ref_id` beside it and no FK. A merge leaves it — a draft records what an ' +
      'author picked at the time, and repointing it would silently change what they chose. The ' +
      'draft resolves through the tombstone when it is published.',
  },
  {
    table: 'catalog_authoring_draft_variants',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['selected_canonical_variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'catalog_authoring_drafts',
    disposition: 'not_an_entity_reference',
    reason:
      '`flow` names the authoring path (merchant, p2p, operator, connector, verified_brand), an ' +
      'actor route rather than an entity. `selected_canonical_product_id` IS a bare product ' +
      'reference but carries no discriminator, so it is invisible to this derivation too — see ' +
      'the note on the gate about what neither census reaches.',
  },
  {
    table: 'catalog_authoring_schema_invalidations',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'catalog_backfill_records',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`subject_kind` says which subject a backfill record is about; the canonical reference is ' +
      '`canonical_product_id`/`canonical_variant_id`, both FK and both in the plan. `subject_key` ' +
      'is the idempotency key of the SOURCE subject (a store, a listing), not a mergeable id.',
  },
  {
    table: 'catalog_consistency_findings',
    disposition: 'untouched',
    idColumns: ['subject_key'],
    reason:
      'The sweep records what it FOUND at a moment, and `subject_key` names the subject it ' +
      'examined. Evidence is never rehomed: a finding about the loser is a true statement about ' +
      'the loser, and moving it to the winner would attribute one entity’s inconsistency to ' +
      'another. Nothing in #60 deletes evidence either.',
  },
  {
    table: 'catalog_entity_suppressions',
    disposition: 'untouched',
    idColumns: ['entity_id'],
    reason:
      'A real bare reference (`entity_type` + `entity_id`), and #694 settled why it stays here. ' +
      'A merge cannot reach one: `requestMerge` REFUSES a suppressed loser or winner outright, ' +
      'because `suppressEntity` also stamps the entity `status = \'suppressed\'` and every ' +
      'catalogue read filters `active` — so merging would LIFT the suppression (loser) or EXTEND ' +
      'it to unexamined content (winner), and both are operator acts. Repointing was rejected: ' +
      'the row on an `active` winner is the record correct, the enforcement missing, and now ' +
      'looking covered. Contrast `retail_suppressions`, which IS rehomed — its subject is stored ' +
      'twice and the entity carries no suppressed status of its own.',
  },
  {
    table: 'catalog_governance_audit_events',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'catalog_governance_change_requests',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'catalog_localization_revisions',
    disposition: 'untouched',
    idColumns: ['entity_id'],
    reason:
      "#367 box 4's append-only translation trail. `entity_kind` now spans " +
      '`canonical_product` and `canonical_product_family` (L2), both mergeable, with a bare ' +
      '`entity_id` beside it and deliberately no FK — the trail must OUTLIVE its subject. A ' +
      'merge leaves every row where it is, for the reason `watchlist_snapshot_lines` and the ' +
      'curation timeline are left: a revision is a record of what a string SAID at a moment, on ' +
      'the entity it was written for, and repointing it would make the winner appear to have ' +
      'once been called something it never was. ' +
      'The consequence is real and is not hidden: the localization ROWS are rehomed ' +
      '(`repoint_if_absent`) while their history stays under the loser id, so ' +
      '`readLocalizationFieldHistory` on the winner does not show pre-merge revisions. A reader ' +
      'follows `merged_into_id`, one hop by construction (ADR 0002 D16). That split is also what ' +
      'makes the merge legible in the trail at all, which is what the rehoming note above relies ' +
      'on when it declines to mark carried rows stale.',
  },
  {
    table: 'catalog_merge_jobs',
    disposition: 'untouched',
    idColumns: ['loser_id', 'winner_id'],
    reason:
      'The merge’s own history (#654’s first named table). A merge must never rewrite the record ' +
      'of merges: repointing `loser_id` would make a completed job claim it merged something it ' +
      'did not, and repointing `winner_id` would make the ordering of two merges unrecoverable. ' +
      '`catalog_merge_jobs_distinct_check` would additionally refuse the collapse.',
  },
  {
    table: 'catalog_proposal_duplicate_candidates',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['candidate_ref'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'catalog_proposals',
    disposition: 'untouched',
    idColumns: ['resolved_entity_id'],
    reason:
      '`type` + `resolved_entity_id` names the entity a proposal was resolved INTO. Left alone ' +
      'for the reason a revision is: it records what an operator decided at a moment, and the ' +
      'tombstone resolves the pointer without falsifying the decision.',
  },
  {
    table: 'catalog_review_items',
    disposition: 'untouched',
    idColumns: ['subject_id', 'counterpart_id'],
    reason:
      '#654’s third named table. A review item is the QUESTION somebody was asked about two ' +
      'specific rows; rehoming either side would silently change the question after the fact, ' +
      'and `catalog_review_items_self_pair_check` would refuse the case where both collapse onto ' +
      'the winner.',
  },
  {
    table: 'catalog_revisions',
    disposition: 'untouched',
    idColumns: ['entity_id'],
    reason:
      'The audit trail, append-only by trigger. Rehoming it would move one entity’s history onto ' +
      'another — the single most misleading thing a merge could do — and the trigger refuses the ' +
      'UPDATE anyway, so a plan entry that tried would fail at runtime rather than in review.',
  },
  {
    table: 'catalog_source_objects',
    disposition: 'not_an_entity_reference',
    reason:
      '`external_type` describes the type of object the SOURCE published (product, offer, ' +
      'merchant, brand). `external_id` is the source’s own identifier in its own key space, ' +
      'never a Mercaria id. The canonical attachment lives in `canonical_*_source_links`, which ' +
      'are FK and are in the plan.',
  },
  {
    table: 'catalog_source_rejections',
    disposition: 'not_an_entity_reference',
    reason: 'The residual of an ingestion pass. `external_type`/`external_id` are the SOURCE’s, as above.',
  },
  {
    table: 'catalog_split_assignments',
    disposition: 'untouched',
    idColumns: ['item_ref'],
    reason:
      '`item_type` + `item_ref` names each child a split assigns. Frozen by trigger once the job ' +
      'leaves `plan`, precisely so the set an operator approved is the set that executes — a ' +
      'merge rehoming one would edit an approved plan from outside.',
  },
  {
    table: 'catalog_split_jobs',
    disposition: 'untouched',
    idColumns: ['source_entity_id', 'target_entity_id'],
    reason:
      '#654’s second named table, and the merge-job reasoning exactly: a split’s record of what ' +
      'it split must not be rewritten by a later merge of either side.',
  },
  {
    table: 'compatibility_claims',
    disposition: 'not_an_entity_reference',
    reason: '`asserted_by_kind` is an actor role, as in `automotive_fitments`; the subject columns are FK.',
  },
  {
    table: 'disputes',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'draft_order_applied_discounts',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['discount_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'draft_order_line_items',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['listing_id', 'variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'ebay_discovery_queries',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'ebay_reconciliation_samples',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'fee_schedule_acceptances',
    disposition: 'not_an_entity_reference',
    reason: OWNER_STORE_OR_OXY_ACCOUNT,
  },
  {
    table: 'feed_configurations',
    disposition: 'not_an_entity_reference',
    reason: '`owner_kind` is `merchant | operator` — who owns the feed, an actor role rather than a `merchants.id`.',
  },
  {
    table: 'feed_field_mappings',
    disposition: 'not_an_entity_reference',
    reason:
      '`role` is the FEED COLUMN’s role (title, gtin, price, merchant, storefront…). `merchant` ' +
      'there names a column in somebody’s CSV, not an entity.',
  },
  {
    table: 'feed_import_report_entries',
    disposition: 'not_an_entity_reference',
    reason: 'The same `role` vocabulary, on the error report.',
  },
  {
    table: 'generic_compatibility_relations',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`target_kind` says which of `target_family_id`/`target_product_id`/`target_variant_id` is ' +
      'populated — all three FK and all three in the plan, conflict-gated on the ' +
      'distinct-endpoints CHECK (#405). `target_key` is a GENERATED key over them, and ' +
      '`asserted_by_kind` is an actor role.',
  },
  {
    table: 'guest_abuse_counters',
    disposition: 'not_an_entity_reference',
    reason:
      '`axis` names a throttle dimension and the subject is `subject_hash`, an HMAC — there is no ' +
      'id here in either direction, which is the privacy property that domain is built on.',
  },
  {
    table: 'guest_abuse_interventions',
    disposition: 'not_an_entity_reference',
    reason: 'The same `axis` vocabulary and the same hashed subject.',
  },
  {
    table: 'guest_checkouts',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_data_requests',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_legal_holds',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_order_access_grants',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_order_claim_outbox',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_order_claims',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_portal_messages',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'guest_portal_operator_actions',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'ledger_entries',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'ledger_transactions',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'merchant_acquisition_audits',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['merchant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'merchant_activation_capability_events',
    disposition: 'not_an_entity_reference',
    reason: '`actor_kind` is `merchant | operator | system` — who acted, not which merchant.',
  },
  {
    table: 'merchant_activation_policy_acceptances',
    disposition: 'not_an_entity_reference',
    reason: OWNER_STORE_OR_OXY_ACCOUNT,
  },
  {
    table: 'merchant_claim_scopes',
    disposition: 'untouched',
    idColumns: ['scope_ref'],
    reason:
      'A real bare reference: `scope_kind` over merchant/storefront/domain with `scope_ref` ' +
      'beside it. A claim’s scope is the set of facts somebody PROVED; rehoming it would widen ' +
      'or move a proof nobody re-verified, which is the one thing #83’s scope model exists to ' +
      'prevent. Revocation and a fresh claim are the supported path.',
  },
  {
    table: 'merchant_demand_metrics',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['storefront_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'merchant_plan_prices',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'merchant_subscription_events',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'merchant_subscriptions',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'moderation_enforcements',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'navigation_nodes',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`target_kind` selects among FK’d columns including `brand_id` and `product_family_id`, ' +
      'both in the plan. `campaign_url` and `product_type_key` are not entity ids.',
  },
  {
    table: 'notifications',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'offer_price_series',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`scope_kind` selects between `canonical_product_id` and `canonical_variant_id`, both FK ' +
      'and both in the plan (#78 retains the series with the TOMBSTONE — two series cannot be ' +
      'concatenated). `series_key` is GENERATED from them.',
  },
  {
    table: 'offers',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'order_applied_discounts',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['discount_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'order_items',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['listing_id', 'location_id', 'variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'order_status_history',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['actor_guest_session_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'orders',
    disposition: 'not_an_entity_reference',
    reason:
      '`source_channel` is `storefront | pos | draft` — where an order came from. `storefront` ' +
      'matches by word only and names no `storefronts.id`; #59 merge invariant 3 keeps orders ' +
      'out of the plan entirely.',
  },
  {
    table: 'payment_discrepancies',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'payment_provider_events',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'payment_repairs',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'payments',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'price_alerts',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['rehomed_from_canonical_product_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'price_signal_evaluations',
    disposition: 'discriminates_foreign_keys',
    reason: '`scope_kind` selects between the FK’d product and variant columns; `subject_key` is GENERATED from them.',
  },
  {
    table: 'price_signal_feedback',
    disposition: 'discriminates_foreign_keys',
    reason: 'As `price_signal_evaluations`, plus an FK’d `merchant_id`.',
  },
  {
    table: 'price_signal_runs',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['cursor_canonical_product_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'product_type_fields',
    disposition: 'not_an_entity_reference',
    reason: '`flow` is the authoring path a field appears in, as in `catalog_authoring_drafts`.',
  },
  {
    table: 'provider_accounts',
    disposition: 'not_an_entity_reference',
    reason: OWNER_STORE_OR_OXY_ACCOUNT,
  },
  {
    table: 'purchase_order_documents',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'purchase_orders',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['order_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'push_tokens',
    disposition: 'not_an_entity_reference',
    reason: NOT_A_ROW_ID_AT_ALL,
  },
  {
    table: 'referral_attributions',
    disposition: 'untouched',
    idColumns: ['subject_ref'],
    reason:
      'A real bare reference — `subject_kind` is `oxy_user | guest_checkout | merchant` and a ' +
      '`merchant` subject’s `subject_ref` IS a `merchants.id`. Left alone deliberately: an ' +
      'attribution records who acquired whom at a moment, and moving it would credit one ' +
      'merchant’s acquisition to another. The referral domain is walled off from curation by ' +
      'its own isolation gates.',
  },
  {
    table: 'referral_campaign_budgets',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_conversions',
    disposition: 'not_an_entity_reference',
    reason: MERCARIA_ROW_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'referral_enforcement_actions',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'referral_events',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'referral_partner_applications',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_partners',
    disposition: 'not_an_entity_reference',
    reason: OWNER_STORE_OR_OXY_ACCOUNT,
  },
  {
    table: 'referral_payout_batches',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_pilot_cohorts',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_programs',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_reward_rules',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'referral_rewards',
    disposition: 'not_an_entity_reference',
    reason: NOT_A_ROW_ID_AT_ALL,
  },
  {
    table: 'referral_risk_signals',
    disposition: 'not_an_entity_reference',
    reason: POLYMORPHIC_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'referral_subject_redirects',
    disposition: 'untouched',
    idColumns: ['from_ref', 'to_ref'],
    reason:
      'The referral domain’s OWN redirect chain, with the same `subject_kind` vocabulary. It ' +
      'records where a subject moved for attribution purposes; a merge writing into it would ' +
      'forge a referral history. Its own domain owns any repointing.',
  },
  {
    table: 'referral_terms_acceptances',
    disposition: 'not_an_entity_reference',
    reason: STABLE_IDENTITY_SAME_TABLE,
  },
  {
    table: 'refund_line_items',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['location_id', 'variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'refunds',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'retail_cost_quote_acceptances',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'retail_cost_quotes',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_product_id', 'canonical_variant_id', 'procurement_offer_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'retail_customer_adjustments',
    disposition: 'not_an_entity_reference',
    reason: SELF_REFERENCE_DRIZZLE_OMITS,
  },
  {
    table: 'retail_eligibility_audits',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['subject_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'retail_eligibility_decisions',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_variant_id', 'procurement_offer_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'retail_fulfilment_intents',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'retail_procurement_intent_lines',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_product_id', 'canonical_variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'retail_procurement_intents',
    disposition: 'not_an_entity_reference',
    reason: CHECKOUT_GROUP_TOKEN,
  },
  {
    table: 'retail_reconciliation_operator_actions',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['order_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'retail_service_request_evidence',
    disposition: 'not_an_entity_reference',
    reason: OXY_FILE_BESPOKE,
  },
  {
    table: 'retail_suppressions',
    disposition: 'discriminates_foreign_keys',
    reason:
      'The one to read. A recall stores its subject TWICE — a typed FK (`canonical_product_id`, ' +
      '`canonical_variant_id`, `brand_id`) plus the polymorphic `scope`/`scope_ref` the ' +
      'derivation matches on — forced equal by CHECK, so the plan moves BOTH together and the ' +
      'absence guard is narrowed to the partial unique’s own `WHERE lifted_at IS NULL`.',
  },
  {
    table: 'return_request_evidence',
    disposition: 'not_an_entity_reference',
    reason: OXY_FILE_BESPOKE,
  },
  {
    table: 'review_aggregates',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`scope`/`target_type` select among FK’d columns (`canonical_product_id`, `merchant_id`), ' +
      'both in the plan; `target_key` is GENERATED from them.',
  },
  {
    table: 'review_eligibilities',
    disposition: 'discriminates_foreign_keys',
    reason: 'The same pair of vocabularies over the same FK’d columns.',
  },
  {
    table: 'review_target_migrations',
    disposition: 'untouched',
    idColumns: ['from_target_ref', 'to_target_ref'],
    reason:
      'The append-only record of #76’s classification decisions, with bare refs on both sides. ' +
      'Evidence again: it says where a review WAS and where it went, and rehoming either end ' +
      'would make the trail describe a move that never happened.',
  },
  {
    table: 'reviews',
    disposition: 'discriminates_foreign_keys',
    reason:
      '`target_type`/`scope` select among FK’d columns; the merge’s reviews phase moves them and ' +
      'then RECORDS what the guard left behind (#333).',
  },
  {
    table: 'search_intent_sessions',
    disposition: 'not_an_entity_reference',
    reason: NOT_A_ROW_ID_AT_ALL,
  },
  {
    table: 'search_intent_turns',
    disposition: 'not_an_entity_reference',
    reason: MERCARIA_ROW_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'seller_draft_images',
    disposition: 'not_an_entity_reference',
    reason: OXY_FILE_BESPOKE,
  },
  {
    table: 'seller_listing_drafts',
    disposition: 'not_an_entity_reference',
    reason:
      '`entry_path` is how a seller STARTED a draft (canonical_product, identifier_scan, ' +
      'catalog_search…) — a route through the wizard, not a reference. The real link is the FK’d ' +
      '`canonical_product_id`/`canonical_variant_id`.',
  },
  {
    table: 'shopping_agent_finding_lines',
    disposition: 'not_an_entity_reference',
    reason: MERCARIA_ROW_OUTSIDE_THE_SEVEN,
  },
  {
    table: 'shopping_agents',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['excluded_merchant_ids', 'rehomed_from_canonical_product_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'source_records',
    disposition: 'not_an_entity_reference',
    reason: '`external_type`/`external_id` are the SOURCE’s, as in `catalog_source_objects`.',
  },
  {
    table: 'stores',
    disposition: 'not_an_entity_reference',
    reason: NOT_A_ROW_ID_AT_ALL,
  },
  {
    table: 'supplier_quotes',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['canonical_product_id', 'canonical_variant_id', 'order_id', 'procurement_offer_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'supplier_reservations',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['consumed_order_id', 'procurement_offer_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'supplier_sourcing_attempts',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['procurement_offer_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
  {
    table: 'sync_run_record_failures',
    disposition: 'not_an_entity_reference',
    reason: FOREIGN_KEY_SPACE_BESPOKE,
  },
  {
    table: 'transfers',
    disposition: 'not_an_entity_reference',
    reason: PAYMENT_COMMERCE_CORRELATION,
  },
  {
    table: 'watchlist_snapshot_items',
    disposition: 'covered_by_bare_entity_census',
    idColumns: ['selected_canonical_variant_id'],
    reason: BARE_CENSUS_OWNS_IT,
  },
];

/**
 * THE BARE-REFERENCE CENSUS — #695's half, and the third door into #59 merge
 * invariant 2.
 *
 * `merge-plan-census.test.ts` derives its population from drizzle FOREIGN KEYS.
 * `POLYMORPHIC_ENTITY_REFERENCES` derives its population from drizzle
 * `enumValues`. A column that is a mergeable entity id **by convention alone**
 * — no foreign key to walk and no discriminator whose vocabulary a census can
 * key on — is in neither population, cannot fail either build, and never will.
 *
 * ## What the measurement found, and why it is not one column
 *
 * #695 had a single confirmed instance and said outright that counting them was
 * the hard part. Measured against the schema at `4bff6ef3`, the population is
 * THIRTY-ONE columns across twenty tables, and it arrives through four distinct
 * doors rather than one:
 *
 *  1. **An `_id` column with a deliberate no-FK decision.** The largest group.
 *     Every one is already in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with a written
 *     reason, so somebody decided the CONSTRAINT question — and nobody was ever
 *     asked the MERGE question, which is a different one.
 *  2. **A discriminator that spells the same entity differently.**
 *     `attribute_value_reviews.entity_id` and
 *     `attribute_reindex_requests.entity_id` are polymorphic over a canonical
 *     product and a canonical variant, discriminated by `entity_kind` — whose
 *     tuple is `['product', 'variant']`. Neither value is in
 *     `MERGEABLE_ENTITY_TYPES`, so the polymorphic census cannot see them. This
 *     is the door worth remembering: the table HAS a discriminator sitting
 *     right there, which is exactly what makes the gap read as coverage.
 *  3. **A column whose name does not end in `_id`.**
 *     `catalog_proposal_duplicate_candidates.candidate_ref` is polymorphic over
 *     eight entity kinds, half of them mergeable. It is in the id-column ledger
 *     only because somebody added it VOLUNTARILY — `findIdColumnViolations`
 *     keys on an `_id` suffix, so deleting that entry would produce no
 *     violation at all.
 *  4. **An ARRAY of entity ids.** Postgres has no per-element foreign key, so
 *     these are structurally incapable of entering the FK census; and the
 *     plural `_ids` spelling means the id-column ledger never demanded an entry
 *     either, so three of them are in no register anywhere.
 *     `shopping_agents.excluded_merchant_ids` carries the schema comment "No FK
 *     — a merge repoints, a delete cannot", and nothing repoints it.
 *
 * ## Why this is a census and not a foreign key
 *
 * The tempting fix is upstream: give the column a real `.references(...)` and
 * let the FK census take it. Measured, that is unavailable for all thirty-one.
 * The array columns cannot carry one at all. The polymorphic ones span eight
 * tables. And every remaining entry is a SNAPSHOT, a telemetry correlation, a
 * provenance stamp or a keyset cursor whose ledger reason states that each
 * `ON DELETE` a key could declare breaks the property the column exists for —
 * `MERGEABLE_AUTHORING_SELECTION` says it for ADR 0007 D10 in as many words.
 * Adding a discriminator instead does not help either, which is door 2's whole
 * point.
 *
 * ## So the POPULATION is derived and only the DISPOSITION is declared
 *
 * The derivation is `MERCARIA_ROW_ID_REASONS`: every `ID_COLUMNS_WITHOUT_
 * FOREIGN_KEY` entry whose reason names a row in THIS database. That set is
 * itself kept complete by an existing gate — `findIdColumnViolations` refuses
 * any unclassified `_id` column — so a new bare `canonical_product_id` cannot
 * be added without a ledger entry, and a ledger entry under one of those six
 * reasons cannot be added without an entry here. Two derived gates in a chain,
 * and the decision lands on the person adding the reference.
 *
 * **The limit, stated rather than left to be discovered:** doors 2, 3 and 4 are
 * DECLARED here and are NOT add-gated, because no derivation reaches them —
 * that is #695's finding, not an omission this file repairs. A new array of
 * merchant ids will not fail the build. `bare-entity-census.test.ts` pins the
 * six entries covering those doors so they cannot be quietly dropped, and the
 * residual is recorded in the issue rather than in a gate that cannot fire.
 */
export type BareEntityReferenceDisposition =
  /**
   * The target is a real row in this database and is NOT one of the seven
   * mergeable entities — a listing, a native `product_variants` row, a
   * discount, a location, an order, an offer, a procurement offer, a category,
   * a store, a guest session, a cart. Distinct from an absent entry on purpose:
   * this says somebody read the column and checked what it points at.
   */
  | 'not_a_mergeable_entity'
  /**
   * The column's table is declared in `POLYMORPHIC_ENTITY_REFERENCES`, which
   * owns the decision. Recorded rather than omitted so the pairing is visible
   * from either gate — the `discriminates_foreign_keys` device, one census over.
   */
  | 'covered_by_polymorphic_census'
  /** A real bare reference to a mergeable entity that a merge deliberately does not move. */
  | 'untouched'
  /** A real bare reference to a mergeable entity that a merge rehomes. */
  | 'rehomed'
  /**
   * A real bare reference to a mergeable entity that NOTHING moves and whose
   * correct disposition has not been decided.
   *
   * Deliberately not spelled `untouched`: that word claims a decision, and
   * claiming one nobody made is how this whole class of gap was created. Every
   * entry naming it is a LIVE pointer rather than a snapshot, so a merge leaves
   * it addressing a tombstone and the behaviour it drives silently stops.
   */
  | 'unresolved';

/**
 * How a merge moves an id that lives INSIDE an array column.
 *
 * The FK-derived plan cannot carry these: `merge-plan-census.test.ts` asserts
 * both directions, so a `RehomeTarget` naming a column with no foreign key fails
 * as `extra` — and an array column can never have one (#695 door 4). So the
 * declaration lives on the bare-entity register, which is the register for
 * exactly these, and this is what makes `rehomed` an executed fact rather than a
 * word: {@link BareEntityReference} requires it whenever the disposition is
 * `rehomed`, and the merge runner derives its array work from the register, so
 * the declaration and the statement are ONE source and cannot disagree.
 *
 * That property is the whole point of this issue. `shopping_agents`'s own
 * schema comment claimed "a merge repoints" while nothing repointed it, and a
 * comment asserting behaviour is indistinguishable from the behaviour.
 */
export interface BareArrayRehome {
  /** The real drizzle array column, so a rename breaks the build. */
  readonly column: AnyPgColumn;
  /** Which phase moves it. Ordering is the plan's, not the runner's. */
  readonly phase: CatalogMergePhase;
}

export interface BareEntityReference {
  /** `table.column`, both POSTGRES names — never the TypeScript property. */
  readonly column: string;
  readonly disposition: BareEntityReferenceDisposition;
  /**
   * The mergeable entities the column can name. Required for `untouched`,
   * `rehomed` and `unresolved`, and forbidden for the other two — an entry
   * claiming a merge leaves a reference alone has to say WHICH entity, or it is
   * a sentence rather than a decision.
   */
  readonly targetEntities?: readonly MergeableEntityType[];
  /**
   * REQUIRED when the disposition is `rehomed`, and forbidden otherwise —
   * asserted by `bare-entity-census.test.ts`, which also checks this column's
   * postgres name against {@link column}, so the string and the drizzle
   * reference cannot name two different columns.
   */
  readonly rehome?: BareArrayRehome;
  readonly reason: string;
}

/** The snapshot reason, written once: these repeat across four domains. */
const SNAPSHOT_UNTOUCHED =
  'A frozen commerce snapshot. The row records what was bought or quoted at an instant, and ' +
  'rehoming it would rewrite a purchase to name a product the buyer never saw. The tombstone ' +
  'resolves the pointer for anybody who follows it.';

/** The telemetry reason, written once: these repeat across `analytics_*`. */
const TELEMETRY_UNTOUCHED =
  'A telemetry observation. Rehoming would move one entity’s measured history onto another and ' +
  'silently restate every rollup already computed from it; the observation is a fact about what ' +
  'a person saw, which a later merge does not change.';

/** The not-mergeable reason, written once: these repeat across every domain. */
const TARGET_NOT_MERGEABLE =
  'Read against the schema: the target is a real row in this database and is not one of the ' +
  'seven mergeable entities, so no merge can act on it and there is nothing for a rehoming ' +
  'plan to cover.';

/** The polymorphic-census hand-off, written once. */
const OWNED_BY_POLYMORPHIC_CENSUS =
  'The table is declared in `POLYMORPHIC_ENTITY_REFERENCES`, which derives its population from ' +
  'this column’s own discriminator and carries the merge decision. Recorded here so the pairing ' +
  'is visible from either gate rather than looking like an omission in both.';

/**
 * Every bare reference, and what a merge does with it.
 *
 * Ordered by column so a diff that adds one lands next to its neighbours.
 */
export const BARE_ENTITY_REFERENCES: readonly BareEntityReference[] = [
  // ── Telemetry (#77) ───────────────────────────────────────────────────────
  {
    column: 'analytics_events.canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason: TELEMETRY_UNTOUCHED,
  },
  {
    column: 'analytics_events.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: TELEMETRY_UNTOUCHED,
  },
  {
    column: 'analytics_events.merchant_id',
    disposition: 'untouched',
    targetEntities: ['merchant'],
    reason: TELEMETRY_UNTOUCHED,
  },
  {
    column: 'analytics_events.storefront_id',
    disposition: 'untouched',
    targetEntities: ['storefront'],
    reason: TELEMETRY_UNTOUCHED,
  },
  { column: 'analytics_events.listing_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'analytics_events.offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'analytics_events.order_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'analytics_events.product_variant_id',
    disposition: 'not_a_mergeable_entity',
    reason:
      'A NATIVE `product_variants` row — a seller’s own listing variant, not a `canonical_variant`. ' +
      'The two are one word apart and only one of them merges, which is why this entry exists.',
  },
  { column: 'analytics_events.store_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'analytics_rollups.merchant_id',
    disposition: 'untouched',
    targetEntities: ['merchant'],
    reason: TELEMETRY_UNTOUCHED,
  },
  { column: 'analytics_rollups.store_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'analytics_search_queries.category_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },

  // ── Authoring drafts (#367 / ADR 0007 D10) ────────────────────────────────
  {
    column: 'catalog_authoring_draft_values.canonical_ref_id',
    disposition: 'covered_by_polymorphic_census',
    reason: OWNED_BY_POLYMORPHIC_CENSUS,
  },
  {
    column: 'catalog_authoring_draft_variants.selected_canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason:
      'The variant an author picked, the sibling of the column #695 named. A merge must not move ' +
      'it for that column’s reason: repointing silently changes somebody’s choice, and the ' +
      'publication resolves the selection through the tombstone’s own `merged_into_id`.',
  },
  {
    column: 'catalog_authoring_drafts.selected_canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason:
      '#695’s own instance. A draft records what an author picked at the time, so repointing it ' +
      'would silently change their choice; the publication resolves the selection through the ' +
      'tombstone’s `merged_into_id`, and one that resolves to nothing REFUSES the publish rather ' +
      'than unlinking in silence (ADR 0007 D10).',
  },

  // ── Curation’s own trail (#59 / #654) ─────────────────────────────────────
  { column: 'catalog_entity_suppressions.entity_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_merge_jobs.loser_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_merge_jobs.winner_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_review_items.counterpart_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_review_items.subject_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_revisions.entity_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_split_jobs.source_entity_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },
  { column: 'catalog_split_jobs.target_entity_id', disposition: 'covered_by_polymorphic_census', reason: OWNED_BY_POLYMORPHIC_CENSUS },

  // ── Commerce snapshots ────────────────────────────────────────────────────
  { column: 'cancellation_request_lines.variant_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'cart_merges.guest_session_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'cart_merges.target_cart_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'draft_order_applied_discounts.discount_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'draft_order_line_items.listing_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'draft_order_line_items.variant_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'order_applied_discounts.discount_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'order_items.listing_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'order_items.location_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'order_items.variant_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'order_status_history.actor_guest_session_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'refund_line_items.location_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'refund_line_items.variant_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'return_request_lines.variant_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },

  // ── Procurement and retail snapshots (#118 / #122 / #123 / #124) ──────────
  {
    column: 'purchase_order_lines.canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  {
    column: 'purchase_order_lines.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  { column: 'purchase_order_lines.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'purchase_orders.order_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'retail_cost_quotes.canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  {
    column: 'retail_cost_quotes.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  { column: 'retail_cost_quotes.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'retail_eligibility_decisions.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  { column: 'retail_eligibility_decisions.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'retail_eligibility_audits.subject_id',
    disposition: 'not_a_mergeable_entity',
    reason:
      'The subject’s TABLE is named beside it in `subject_table`, and every value that column ' +
      'takes is a retail-eligibility row (a policy version, a document, a recall, an exception). ' +
      'None of the seven mergeable entities is reachable through it.',
  },
  {
    column: 'retail_procurement_intent_lines.canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  {
    column: 'retail_procurement_intent_lines.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  { column: 'retail_reconciliation_operator_actions.order_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  {
    column: 'supplier_quotes.canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  {
    column: 'supplier_quotes.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason: SNAPSHOT_UNTOUCHED,
  },
  { column: 'supplier_quotes.order_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'supplier_quotes.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'supplier_reservations.consumed_order_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'supplier_reservations.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },
  { column: 'supplier_sourcing_attempts.procurement_offer_id', disposition: 'not_a_mergeable_entity', reason: TARGET_NOT_MERGEABLE },

  // ── Doors 2 to 5: declared here, reachable by NO derivation ───────────────
  // Every entry below is outside `MERCARIA_ROW_ID_REASONS`, so the add-direction
  // gate cannot fire for a new sibling of any of them. That is #695's finding
  // restated as data; `bare-entity-census.test.ts` pins this exact set so the
  // work already done cannot be dropped, and nothing pretends the door is shut.
  //
  // Door 5 is the largest and the least dramatic: an `_id` column ledgered
  // under a BESPOKE reason rather than one of the six shared constants. 138 of
  // the ledger's 528 entries are written that way (measured against the
  // constants themselves, now that `FOREIGN_KEY_SPACE_ID_REASONS` makes the
  // three-way split exact: 333 foreign key space, 57 shared Mercaria-row, 138
  // bespoke), so THIS derivation cannot reach them; the nine below are the ones
  // a hand census of that set found to name a mergeable entity, each read
  // against the schema rather than its name.
  //
  // #720 note: door 5 is also where BOTH of that issue's synonym instances sit,
  // which is why `polymorphic-entity-census.test.ts` subtracts only the foreign
  // key spaces and keeps every bespoke entry in its population.
  {
    column: 'affiliate_outbound_clicks.canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason:
      'Door 5. The configuration a click was for, recorded at that instant. Its ledger reason ' +
      'already argues the merge case in as many words: a key here would make it a live reference ' +
      'a rehoming moves, putting a past click onto the winner of a merge that happened afterwards.',
  },
  {
    column: 'affiliate_outbound_clicks.merchant_id',
    disposition: 'untouched',
    targetEntities: ['merchant'],
    reason:
      'Door 5. The merchant the buyer was sent to, as the OFFER named it at that instant. ' +
      'Rehoming would restate where somebody was sent, which is the one thing an outbound click ' +
      'record exists to answer.',
  },
  {
    column: 'affiliate_outbound_clicks.storefront_id',
    disposition: 'untouched',
    targetEntities: ['storefront'],
    reason: 'Door 5. The channel the offer sat on at that instant, beside `merchant_id` and for its reason.',
  },
  {
    column: 'merchant_acquisition_audits.merchant_id',
    disposition: 'untouched',
    targetEntities: ['merchant'],
    reason:
      'Door 5. An audit of what an operator TRIED, which has to outlive the thing they tried it ' +
      'on. Rehoming would move one merchant’s acquisition history onto another — the misreading ' +
      '`catalog_revisions.entity_id` is left alone to prevent.',
  },
  {
    column: 'merchant_demand_metrics.storefront_id',
    disposition: 'untouched',
    targetEntities: ['storefront'],
    reason:
      'Door 5. A reporting DIMENSION whose empty string means "not sliced by one", so it is not ' +
      'even always an id. A measured figure is a fact about a window that a later merge does not ' +
      'change — `TELEMETRY_UNTOUCHED`, one domain over.',
  },
  {
    column: 'price_alerts.rehomed_from_canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason:
      'Door 5, and the one that would be actively self-defeating to move: it is the PROVENANCE ' +
      'stamp the merge’s own `alerts` phase writes to record where an alert came from. Rehoming ' +
      'it would erase the record of the rehoming.',
  },
  {
    column: 'price_signal_runs.cursor_canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason:
      'Door 5. A KEYSET CURSOR, not a reference — it records where a sweep had reached. Moving it ' +
      'would make a paused run resume somewhere else in its own ordering and double-count into a ' +
      'counter CHECK that then refuses the row.',
  },
  {
    column: 'shopping_agents.rehomed_from_canonical_product_id',
    disposition: 'untouched',
    targetEntities: ['canonical_product'],
    reason:
      'Door 5, the `price_alerts` stamp one domain over and written by the merge’s `agents` ' +
      'phase. Same reason: rehoming the record of a rehoming destroys what it records.',
  },
  {
    column: 'watchlist_snapshot_items.selected_canonical_variant_id',
    disposition: 'untouched',
    targetEntities: ['canonical_variant'],
    reason:
      'Door 5. The configuration a snapshot’s selected offer priced. A variant merged away later ' +
      'is still what was measured that day, and #81 correction rule 5 keeps the history naming ' +
      'what it actually used.',
  },
  {
    column: 'attribute_reindex_requests.entity_id',
    disposition: 'unresolved',
    targetEntities: ['canonical_product', 'canonical_variant'],
    reason:
      'Door 2. Polymorphic over a canonical product or variant, discriminated by `entity_kind` — ' +
      'whose tuple is `[product, variant]`, so neither value is in `MERGEABLE_ENTITY_TYPES` and ' +
      'the polymorphic census cannot see the table at all. A LIVE queue row, not a snapshot: a ' +
      'merge leaves the request naming a tombstone and the reindex it schedules never happens. ' +
      'Nothing in `MERGE_REHOMING_PLAN` touches it and no decision has been recorded.',
  },
  {
    column: 'attribute_value_reviews.entity_id',
    disposition: 'unresolved',
    targetEntities: ['canonical_product', 'canonical_variant'],
    reason:
      'Door 2, beside `attribute_reindex_requests.entity_id` and for the same `entity_kind` ' +
      'vocabulary. An OPEN review is a live question about a row that still exists; after a merge ' +
      'it addresses a tombstone, so a reviewer answering it resolves an attribute on an entity ' +
      'nobody reads. Nothing rehomes it and no decision has been recorded.',
  },
  {
    column: 'catalog_proposal_duplicate_candidates.candidate_ref',
    disposition: 'untouched',
    targetEntities: [
      'organization',
      'brand',
      'merchant',
      'storefront',
      'canonical_product_family',
      'canonical_product',
      'canonical_variant',
    ],
    reason:
      'Door 3. Polymorphic across eight kinds and NOT `_id`-shaped, so its ledger entry is ' +
      'voluntary — `findIdColumnViolations` would report nothing if somebody deleted it. Left ' +
      'alone for `catalog_revisions.entity_id`’s reason: it is evidence of what a scan compared ' +
      'against at a moment, and rehoming it would make a past detection claim it examined a row ' +
      'that did not exist yet.',
  },
  {
    column: 'navigation_saved_queries.brand_ids',
    disposition: 'rehomed',
    targetEntities: ['brand'],
    rehome: { column: navigationSavedQueries.brandIds, phase: 'navigation' },
    reason:
      'Door 4, REHOMED (#717). A `text[]` of brand ids: Postgres has no per-element foreign key, ' +
      'and the plural spelling means the id-column ledger never demanded an entry either, so ' +
      'until #716 built the array rehomer this column was in no register anywhere. A LIVE ' +
      'filter, so the #716 ruling applies unchanged one entity over: an operator who curated a ' +
      'query around a brand meant the BRAND, which after a merge trades under the surviving ' +
      'identity. Left on a tombstone the curated search silently stops matching that brand’s ' +
      'products, and a menu that quietly returns less is the failure nobody reports.',
  },
  {
    column: 'navigation_saved_queries.merchant_ids',
    disposition: 'rehomed',
    targetEntities: ['merchant'],
    rehome: { column: navigationSavedQueries.merchantIds, phase: 'navigation' },
    reason:
      'Door 4, beside `brand_ids` and with the same consequence one entity over, REHOMED for the ' +
      'same reason (#717). `category_id` on the same row carries a real `restrict` key; these two ' +
      'carry none only because an array cannot.',
  },
  {
    column: 'shopping_agents.excluded_merchant_ids',
    disposition: 'rehomed',
    targetEntities: ['merchant'],
    rehome: { column: shoppingAgents.excludedMerchantIds, phase: 'agents' },
    reason:
      'Door 4, and the sharpest instance measured (#716). REHOMED, for the reason the four ' +
      'merchant NARROWINGS beside it are — a product save’s preferred seller, a price alert’s ' +
      'scope, a watchlist item’s preferred merchant and `shopping_agent_lines.merchant_id` — ' +
      'with the sign flipped and the stakes raised. A merchant merge here is duplicate ' +
      'resolution rather than an acquisition (`entity_collision` from a `duplicate_scan`: two ' +
      'merchants sharing a domain), so the shopper who excluded the loser excluded the BUSINESS, ' +
      'which after the merge trades under the surviving identity. Left on a tombstone the ' +
      'exclusion matches no offer and the agent recommends the merchant they excluded — where a ' +
      'stranded NARROWING yields nothing and the shopper notices, a stranded EXCLUSION yields ' +
      'MORE and they cannot tell. `merchant_acquisition_candidates` states the same rule for the ' +
      'nearest analogue: a do-not-contact request is exactly the fact a merge must never ' +
      'silently drop. The schema comment already claimed this behaviour; now it is true.',
  },
];

/**
 * The `BARE_ENTITY_REFERENCES` columns NO derivation reaches — the four doors
 * #695 measured, pinned as a literal set.
 *
 * Deriving it would mean deriving exactly the thing #695 established cannot be
 * derived. Its job is narrow and real: a column here has been READ against the
 * schema, and without this list deleting one of them would be green.
 *
 * **It lives here rather than inside one test file because TWO censuses read
 * it** (#720). `bare-entity-census.test.ts` uses it to decide which declared
 * entries it can still re-check; `polymorphic-entity-census.test.ts` uses it to
 * verify that a `covered_by_bare_entity_census` disposition points at a column
 * that census ACTUALLY re-checks, rather than merely at one it has an entry
 * for. Two copies of this list could disagree, and the direction they would
 * disagree in is a disposition citing a census that no longer covers it — which
 * is worse than no disposition, because it stops the next reader.
 */
export const BARE_REFERENCES_NO_DERIVATION_REACHES: readonly string[] = [
  // Door 5 — an `_id` column ledgered under a bespoke reason.
  'affiliate_outbound_clicks.canonical_variant_id',
  'affiliate_outbound_clicks.merchant_id',
  'affiliate_outbound_clicks.storefront_id',
  'merchant_acquisition_audits.merchant_id',
  'merchant_demand_metrics.storefront_id',
  'price_alerts.rehomed_from_canonical_product_id',
  'price_signal_runs.cursor_canonical_product_id',
  'shopping_agents.rehomed_from_canonical_product_id',
  'watchlist_snapshot_items.selected_canonical_variant_id',
  // Door 2 — a discriminator spelling the same entity differently (#720).
  'attribute_reindex_requests.entity_id',
  'attribute_value_reviews.entity_id',
  // Door 3 — a column whose name does not end in `_id`.
  'catalog_proposal_duplicate_candidates.candidate_ref',
  // Door 4 — an array of entity ids.
  'navigation_saved_queries.brand_ids',
  'navigation_saved_queries.merchant_ids',
  'shopping_agents.excluded_merchant_ids',
];
