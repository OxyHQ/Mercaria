/**
 * Reads and writes for `offers` (#57).
 *
 * Two shapes here carry more weight than the rest, and both are about
 * convergence rather than about SQL:
 *
 * - {@link upsertExternalOffer} converges on the ACTIVE source mapping
 *   (`offers_active_source_key`), so a re-delivered observation of one external
 *   offer updates the row it already has instead of minting a second. It repeats
 *   the partial index's predicate in its `ON CONFLICT`, which is not optional:
 *   Postgres refuses to infer a partial arbiter without it and the statement
 *   fails with "there is no unique or exclusion constraint matching the ON
 *   CONFLICT specification".
 * - {@link retireOffers} is the ONLY way an offer stops being current, and it is
 *   an UPDATE. Nothing in this module issues a DELETE, which is what makes
 *   "expiry removes stale offers from current results without losing historical
 *   references" (issue acceptance 5) a property of the code rather than of
 *   whoever writes the next sweep.
 *
 * The comparison reads are keyset-paginated on `(price_amount, id)`, matching
 * `offers_variant_comparison_idx` exactly — the index is that query's own ORDER
 * BY, in that column order, or it cannot serve the sort.
 */

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SHOPPER_VISIBLE_CATALOG_STATUSES, conditionKeysInGroup } from '@mercaria/shared-types';
import type {
  ConditionGroup,
  OfferAvailability,
  OfferConditionKey,
  OfferKind,
  OfferRetirementReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { offers } from '../schema/offers.js';
import { storefronts } from '../schema/merchants.js';
import { sourceRecords } from '../schema/provenance.js';

export type OfferRow = typeof offers.$inferSelect;
export type InsertOfferInput = typeof offers.$inferInsert;

/**
 * An offer plus the ONE fact a comparison read cannot get from the row: who
 * operates the channel it is sold on.
 *
 * Joined rather than stored, because comparing it with `merchant_id` IS what
 * makes an offer a marketplace offer (ADR 0002 D8) and a stored copy of either
 * side could disagree with the other.
 */
export interface OfferWithChannel {
  offer: OfferRow;
  storefrontOperatorMerchantId: string | null;
}

/**
 * The columns an observation may move.
 *
 * `kind`, `canonical_variant_id`, `first_seen_at` and both generated keys are
 * absent deliberately: an offer that changed kind or variant is a DIFFERENT
 * offer and must be a new row, a first sighting cannot happen twice, and a
 * generated column has no setter. Stating that as a type rather than as a
 * comment is what stops a caller widening it by accident.
 */
export type OfferPatch = Partial<
  Omit<
    InsertOfferInput,
    'id' | 'kind' | 'canonicalVariantId' | 'firstSeenAt' | 'createdAt' | 'sourceKey' | 'commercialKey'
  >
>;

export async function insertOffer(
  db: DatabaseOrTransaction,
  values: InsertOfferInput,
): Promise<OfferRow> {
  const rows = await db.insert(offers).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertOffer returned no row.');
  return row;
}

export async function findOfferById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<OfferRow | undefined> {
  const rows = await db.select().from(offers).where(eq(offers.id, id)).limit(1);
  return rows[0];
}

/** Every offer projecting one native listing, whatever its status. */
export async function findOffersForListing(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<OfferRow[]> {
  return db
    .select()
    .from(offers)
    .where(eq(offers.listingId, listingId))
    .orderBy(asc(offers.createdAt), asc(offers.id));
}

/** The ACTIVE native offer for one native variant, if there is one. */
export async function findActiveNativeOfferForVariant(
  db: DatabaseOrTransaction,
  productVariantId: string,
): Promise<OfferRow | undefined> {
  const rows = await db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.productVariantId, productVariantId),
        eq(offers.kind, 'native'),
        eq(offers.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function updateOffer(
  db: DatabaseOrTransaction,
  id: string,
  patch: OfferPatch,
): Promise<OfferRow | undefined> {
  const rows = await db.update(offers).set(patch).where(eq(offers.id, id)).returning();
  return rows[0];
}

/**
 * Converge an external observation onto its ACTIVE source mapping.
 *
 * The conflict target repeats `offers_active_source_key`'s predicate, without
 * which Postgres cannot infer a partial index (the `ensureCart` lesson, ADR 0003
 * D8). The `set` names every column an observation may legitimately move and
 * NOT `first_seen_at`, which is the point of having both timestamps: a source
 * re-observing an offer it published a year ago must not make it look new.
 *
 * `excluded` is correct here, unlike an incrementing counter: every value is the
 * one this observation proposes, not a function of what is already stored.
 */
export async function upsertExternalOffer(
  db: DatabaseOrTransaction,
  values: InsertOfferInput,
): Promise<OfferRow> {
  const rows = await db
    .insert(offers)
    .values(values)
    .onConflictDoUpdate({
      target: offers.sourceKey,
      // #68: the arbiter is the LIFETIME identity, not the active one.
      //
      // `offers_active_source_key` was partial on `status = 'active'`, so a
      // retired offer that the source published again did not conflict and a
      // SECOND row was inserted for the same external object — acceptance 5's
      // failure, and one that leaves the observed history split across two
      // rows with no way to rejoin them. `offers_source_identity_key` drops the
      // status from the predicate, so an external offer is one row for its
      // whole life and a return is an UPDATE.
      targetWhere: sql`${offers.externalOfferId} is not null
        and (${offers.retirementReason} is null or ${offers.retirementReason} <> 'superseded')`,
      set: {
        // THE REVIVAL (#68 acceptance 5). A source republishing an object it
        // stopped publishing brings the SAME offer back: same id, same
        // `first_seen_at`, same `source_record_id` chain behind it — so a save,
        // a price alert or an operator's link still resolves. Minting a fresh
        // row would satisfy the word "revive" and destroy the thing.
        status: sql`'active'`,
        retirementReason: sql`null`,
        retiredAt: sql`null`,
        // Cleared on revival: the source is publishing it again, so whatever it
        // once said about the object being gone is no longer its position.
        declaredUnavailableAt: sql`null`,
        merchantId: sql`excluded.merchant_id`,
        storefrontId: sql`excluded.storefront_id`,
        sourceRecordId: sql`excluded.source_record_id`,
        priceAmount: sql`excluded.price_amount`,
        priceCurrency: sql`excluded.price_currency`,
        compareAtPriceAmount: sql`excluded.compare_at_price_amount`,
        compareAtPriceCurrency: sql`excluded.compare_at_price_currency`,
        availability: sql`excluded.availability`,
        availableQuantity: sql`excluded.available_quantity`,
        condition: sql`excluded.condition`,
        // #90: the four mapping columns move TOGETHER with the key. Carrying
        // the key without them would leave a row claiming `refurbished_seller`
        // beside the previous observation's source wording and confidence — a
        // combination the shape CHECKs refuse, which is what makes the
        // omission a failed write rather than a quietly wrong provenance.
        conditionSourceLabel: sql`excluded.condition_source_label`,
        conditionMappingState: sql`excluded.condition_mapping_state`,
        conditionMappingConfidence: sql`excluded.condition_mapping_confidence`,
        conditionMappingRulesetId: sql`excluded.condition_mapping_ruleset_id`,
        sellerSku: sql`excluded.seller_sku`,
        merchantTitle: sql`excluded.merchant_title`,
        merchantVariantText: sql`excluded.merchant_variant_text`,
        destinationUrl: sql`excluded.destination_url`,
        affiliateNetwork: sql`excluded.affiliate_network`,
        affiliateProgramRef: sql`excluded.affiliate_program_ref`,
        affiliatePublisherRef: sql`excluded.affiliate_publisher_ref`,
        affiliateTrackingTemplate: sql`excluded.affiliate_tracking_template`,
        country: sql`excluded.country`,
        region: sql`excluded.region`,
        language: sql`excluded.language`,
        customerEligibility: sql`excluded.customer_eligibility`,
        deliveryCostAmount: sql`excluded.delivery_cost_amount`,
        deliveryCostCurrency: sql`excluded.delivery_cost_currency`,
        deliveryFreeOverAmount: sql`excluded.delivery_free_over_amount`,
        deliveryFreeOverCurrency: sql`excluded.delivery_free_over_currency`,
        deliveryMinDays: sql`excluded.delivery_min_days`,
        deliveryMaxDays: sql`excluded.delivery_max_days`,
        pickupState: sql`excluded.pickup_state`,
        returnPolicyUrl: sql`excluded.return_policy_url`,
        returnPolicyWindowDays: sql`excluded.return_policy_window_days`,
        returnPolicyRef: sql`excluded.return_policy_ref`,
        observedAt: sql`excluded.observed_at`,
        // NOT `first_seen_at` — see the docblock.
        lastSeenAt: sql`excluded.last_seen_at`,
        lastConfirmedAt: sql`excluded.last_confirmed_at`,
        staleAt: sql`excluded.stale_at`,
        sourceConfidence: sql`excluded.source_confidence`,
        qualitySignals: sql`excluded.quality_signals`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('upsertExternalOffer returned no row.');
  return row;
}

/**
 * Converge a NATIVE offer onto its variant's active projection.
 *
 * A different arbiter from {@link upsertExternalOffer} because a native offer
 * has a different identity: it is one per native variant
 * (`offers_active_native_variant_key`), not one per external source mapping,
 * and it carries no source key at all — `offers_native_source_key_check` refuses
 * one. The predicate is repeated for the same partial-index reason.
 *
 * `first_seen_at` is again absent from the `set`: a listing republished after a
 * spell as a draft is the same offer coming back, not a new one.
 */
export async function upsertNativeOffer(
  db: DatabaseOrTransaction,
  values: InsertOfferInput,
): Promise<OfferRow> {
  const rows = await db
    .insert(offers)
    .values(values)
    .onConflictDoUpdate({
      target: offers.productVariantId,
      targetWhere: sql`${offers.kind} = 'native' and ${offers.status} = 'active'`,
      set: {
        listingId: sql`excluded.listing_id`,
        canonicalVariantId: sql`excluded.canonical_variant_id`,
        priceAmount: sql`excluded.price_amount`,
        priceCurrency: sql`excluded.price_currency`,
        compareAtPriceAmount: sql`excluded.compare_at_price_amount`,
        compareAtPriceCurrency: sql`excluded.compare_at_price_currency`,
        availability: sql`excluded.availability`,
        availableQuantity: sql`excluded.available_quantity`,
        condition: sql`excluded.condition`,
        // #90: the four mapping columns move TOGETHER with the key. Carrying
        // the key without them would leave a row claiming `refurbished_seller`
        // beside the previous observation's source wording and confidence — a
        // combination the shape CHECKs refuse, which is what makes the
        // omission a failed write rather than a quietly wrong provenance.
        conditionSourceLabel: sql`excluded.condition_source_label`,
        conditionMappingState: sql`excluded.condition_mapping_state`,
        conditionMappingConfidence: sql`excluded.condition_mapping_confidence`,
        conditionMappingRulesetId: sql`excluded.condition_mapping_ruleset_id`,
        sellerSku: sql`excluded.seller_sku`,
        merchantTitle: sql`excluded.merchant_title`,
        merchantVariantText: sql`excluded.merchant_variant_text`,
        observedAt: sql`excluded.observed_at`,
        lastSeenAt: sql`excluded.last_seen_at`,
        lastConfirmedAt: sql`excluded.last_confirmed_at`,
        staleAt: sql`excluded.stale_at`,
        qualitySignals: sql`excluded.quality_signals`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('upsertNativeOffer returned no row.');
  return row;
}

/**
 * Retire offers — the ONLY way one leaves current results.
 *
 * An UPDATE and never a DELETE: the row, its `source_record_id` and the
 * append-only `source_records` chain behind it are the historical reference
 * issue #57's acceptance 5 requires be kept. Scoped to `status = 'active'` so a
 * repeat is a genuine no-op rather than a rewrite of the reason a previous
 * retirement recorded.
 */
export async function retireOffers(
  db: DatabaseOrTransaction,
  offerIds: readonly string[],
  reason: OfferRetirementReason,
  now: Date = new Date(),
): Promise<number> {
  if (offerIds.length === 0) return 0;
  const rows = await db
    .update(offers)
    .set({ status: 'retired', retirementReason: reason, retiredAt: now })
    .where(and(inArray(offers.id, [...offerIds]), eq(offers.status, 'active')))
    .returning({ id: offers.id });
  return rows.length;
}

/**
 * Retire every ACTIVE offer of a source that has stopped publishing them.
 *
 * `keepExternalOfferIds` is what the source DID publish this run; everything
 * else under that (provider, account) pair disappeared. An empty list is a legal
 * and meaningful input — a feed that went empty — so it must not short-circuit
 * into "change nothing", which is why the predicate is built rather than
 * skipped.
 */
export async function retireOffersMissingFromSource(
  db: DatabaseOrTransaction,
  scope: { provider: string; sourceAccountRef: string | null },
  keepExternalOfferIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  const accountPredicate =
    scope.sourceAccountRef === null
      ? isNull(offers.sourceAccountRef)
      : eq(offers.sourceAccountRef, scope.sourceAccountRef);

  const rows = await db
    .update(offers)
    .set({ status: 'retired', retirementReason: 'source_disappeared', retiredAt: now })
    .where(
      and(
        eq(offers.status, 'active'),
        eq(offers.provider, scope.provider),
        accountPredicate,
        isNotNull(offers.externalOfferId),
        // `notInArray`, never `<> all(${jsArray})`: the latter binds a TUPLE and
        // Postgres raises `op ANY/ALL (array) requires array on right side`
        // (CONVENTIONS.md, Naming).
        keepExternalOfferIds.length > 0
          ? notInArray(offers.externalOfferId, [...keepExternalOfferIds])
          : undefined,
      ),
    )
    .returning({ id: offers.id });
  return rows.length;
}

/**
 * Record that a source EXPLICITLY declared these offers' objects gone, and
 * retire them when its policy says to (#68 acceptance 2).
 *
 * ONE statement, because `offers_source_unavailable_reason_check` ties the
 * reason to the declaration: writing the reason first would be refused outright,
 * and writing the declaration first in a separate statement would leave a window
 * in which an offer is marked unavailable with no retirement anybody asked for.
 *
 * `retire` comes from the source's own freshness policy
 * (`retire_on_source_unavailable`), which defaults TRUE — eBay's licence
 * requires deleting content once a listing is no longer publicly available, and
 * retaining something a source says is gone is the direction that breaks a
 * contract rather than a page. A source whose policy says otherwise keeps the
 * offer ACTIVE with the declaration recorded, and `assessOfferFreshness` reads
 * `declared_unavailable_at` FIRST — so the offer answers `unavailable` and
 * leaves comparison either way.
 */
export async function declareOffersUnavailable(
  db: DatabaseOrTransaction,
  input: {
    offerIds: readonly string[];
    declaredAt: Date;
    retire: boolean;
    now: Date;
  },
): Promise<number> {
  if (input.offerIds.length === 0) return 0;
  const rows = await db
    .update(offers)
    .set({
      declaredUnavailableAt: input.declaredAt,
      ...(input.retire
        ? {
            status: 'retired' as const,
            retirementReason: 'source_unavailable' as const,
            retiredAt: input.now,
          }
        : {}),
    })
    .where(and(inArray(offers.id, [...input.offerIds]), eq(offers.status, 'active')))
    .returning({ id: offers.id });
  return rows.length;
}

/**
 * The offers an expiry sweep should CONSIDER — #68's replacement for #57's
 * blind `retireLapsedExternalOffers`.
 *
 * ### Why this returns candidates instead of retiring them
 *
 * #57 retired everything past `stale_at` in one statement. #68 cannot: whether
 * an offer may be retired now depends on its SOURCE's own grace window and on
 * that source's current health, neither of which is a column on this table and
 * neither of which a single UPDATE could join without re-implementing the
 * policy resolution in SQL. A second spelling of the freshness rule is exactly
 * the disagreement that would let a transient outage delist a catalogue.
 *
 * So the repository finds rows whose STORED deadline has passed — indexed,
 * bounded, resumable — and `expiry-sweep.ts` applies the live policy to each.
 * The stored deadline is a conservative PRE-FILTER in the same sense the
 * comparison read's is: it can only offer up fewer candidates than the live
 * policy would, never more, because it is stamped from the same policy at
 * observation time.
 *
 * NATIVE offers are excluded, and the exclusion is a decision rather than an
 * oversight (#57's, unchanged): a native offer's `stale_at` measures how long
 * ago the CONVERGER ran, so sweeping on it would delist a healthy catalogue
 * during a dispatcher outage.
 */
export interface LapsedOfferCandidate {
  offerId: string;
  sourceId: string | null;
  lastSeenAt: Date;
  observedAt: Date;
  firstSeenAt: Date;
  lastConfirmedAt: Date | null;
  declaredUnavailableAt: Date | null;
  /** The offer's own stored deadline — the last-resort contract. */
  staleAt: Date;
}

export async function listLapsedExternalOfferCandidates(
  db: DatabaseOrTransaction,
  input: { limit: number; now: Date },
): Promise<LapsedOfferCandidate[]> {
  const rows = await db
    .select({
      offerId: offers.id,
      sourceId: sourceRecords.sourceId,
      lastSeenAt: offers.lastSeenAt,
      observedAt: offers.observedAt,
      firstSeenAt: offers.firstSeenAt,
      lastConfirmedAt: offers.lastConfirmedAt,
      declaredUnavailableAt: offers.declaredUnavailableAt,
      staleAt: offers.staleAt,
    })
    .from(offers)
    .leftJoin(sourceRecords, eq(sourceRecords.id, offers.sourceRecordId))
    .where(and(eq(offers.status, 'active'), ne(offers.kind, 'native'), lte(offers.staleAt, input.now)))
    .orderBy(asc(offers.staleAt))
    .limit(input.limit);
  return rows;
}

/** How a comparison read is narrowed and paged. */
export interface OfferComparisonQuery {
  /** Exactly one of these two; the service refuses a request carrying both. */
  canonicalVariantId?: string;
  canonicalProductId?: string;
  /** Include only offers published for this market, plus market-less ones. */
  country?: string;
  kinds?: readonly OfferKind[];
  availability?: readonly OfferAvailability[];
  conditions?: readonly OfferConditionKey[];
  /**
   * Whole condition SEGMENTS (#90 acceptance 2) — expanded to their keys by the
   * service, which is what keeps one `IN` list here rather than two predicates
   * that could disagree about `unknown`.
   */
  conditionGroups?: readonly ConditionGroup[];
  /** Exclude offers whose TTL has already passed (issue external rule 3). */
  excludeStale?: boolean;
  limit: number;
  /** Keyset cursor: the last page's final `(priceAmount, id)`. */
  after?: { priceAmount: number | null; id: string };
  now?: Date;
}

/**
 * Where an UNPRICED offer sorts in a price comparison: last.
 *
 * `nulls last` on the ORDER BY alone would not do, because the keyset cursor has
 * to compare against the same value the sort used — so the sort key is an
 * EXPRESSION with this sentinel substituted, and the cursor reads the identical
 * expression. Two different spellings of "where do NULLs go" is exactly the
 * disagreement that makes a keyset page skip rows.
 *
 * `Number.MAX_SAFE_INTEGER` rather than `bigint`'s own maximum: it is above
 * every representable `Money.amount` (`MAX_MONEY_MINOR_UNITS` is the same
 * number), so no real price can collide with it, and it survives the JS
 * round trip a `mode: 'number'` column already imposes.
 */
const UNPRICED_SORT_KEY = Number.MAX_SAFE_INTEGER;

/**
 * The condition predicate, from keys and segments together (#90 acceptance 2).
 *
 * The two inputs are UNIONED into one key set and tested once. A caller asking
 * for the refurbished segment plus one specific used key wants both, and two
 * ANDed `IN` lists would answer with the empty set — silently, and only for the
 * requests that combine them.
 *
 * `undefined` when neither is supplied, so `and(...)` drops it and an
 * unfiltered read stays unfiltered.
 */
function conditionMembership(
  query: Pick<OfferComparisonQuery, 'conditions' | 'conditionGroups'>,
): SQL | undefined {
  const keys = new Set<OfferConditionKey>(query.conditions ?? []);
  for (const group of query.conditionGroups ?? []) {
    for (const key of conditionKeysInGroup(group)) keys.add(key);
  }
  return keys.size > 0 ? inArray(offers.condition, [...keys]) : undefined;
}

/**
 * The canonical statuses a comparison may serve, as a SQL list.
 *
 * Rendered from `SHOPPER_VISIBLE_CATALOG_STATUSES` rather than spelled here, so
 * this predicate and the ones search, the facet rail, the catalogue pages and
 * the merchant catalogue already apply are ONE fact. #628 measured what a second
 * opinion costs: the facet rail said `active` and the search rail said
 * `('active','discontinued')`, and the counts beside the results disagreed.
 */
const SHOPPER_VISIBLE_STATUS_LIST = sql.join(
  SHOPPER_VISIBLE_CATALOG_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * The offers a comparison may serve, scoped to ONE canonical id — and to what a
 * shopper is allowed to see (#367 line 366).
 *
 * ## Why the visibility lives HERE and not in the callers
 *
 * `suppressEntity` (#59 operator action 9) writes `status = 'suppressed'` on the
 * entity and touches no offer and no `native_listing_links` row — deliberately,
 * because retirement is one-way in the offer domain and a lift could not undo
 * it. So a suppression is only ever as real as the reads that consult it, and
 * before this it consulted NONE of them on the offer path: `GET /offers`
 * (#57) and `readProductOfferSummary` (#68) both reach offers through this
 * function and both served a suppressed product's prices in full.
 *
 * It is one predicate at the chokepoint rather than a check in each caller for
 * the reason `stableKeyLabel`'s wall is one module: a rule re-stated per caller
 * is a rule the next caller does not have.
 *
 * ## Both scopes take the SAME subquery, differing only in the column they pin
 *
 * The variant scope needs it because nothing else in the statement touches
 * `canonical_variants` at all; the product scope needs it because its existing
 * semi-join is where a suppressed CONFIGURATION under a visible product has to
 * be dropped. Writing them as one shape is what stops a fix landing on one and
 * leaving the other — which is a live failure mode here, since a product page
 * reads the product scope and the variant picker reads the variant one.
 *
 * ## The width, which is the part to get right
 *
 * `SHOPPER_VISIBLE_CATALOG_STATUSES`, never `status = 'active'`. `discontinued`
 * is in that set on purpose — the maker stopping production is a fact about the
 * world, not Mercaria deciding to hide something, and the offers on it say what
 * is still buyable. Narrowing to `active` would delist every discontinued
 * product while reading as caution, the direction `retail_suppressions` records
 * in `merge-plan.ts` as the dangerous one.
 *
 * A `merged` tombstone is excluded, and that does NOT break an old link: a merge
 * repoints every offer onto the winner (`merge-plan.ts`, phase `offers`, proven
 * by the `verify` phase), and `resolveProductRow` resolves the tombstone to the
 * winner BEFORE anything asks this function for offers. The tombstone has no
 * offers of its own left to hide.
 */
function shopperVisibleScope(query: OfferComparisonQuery): SQL {
  const pin = query.canonicalVariantId
    ? sql`${canonicalVariants.id} = ${query.canonicalVariantId}`
    : sql`${canonicalVariants.productId} = ${query.canonicalProductId ?? ''}`;
  return sql`${offers.canonicalVariantId} in (
    select ${canonicalVariants.id} from ${canonicalVariants}
    join ${canonicalProducts} on ${canonicalProducts.id} = ${canonicalVariants.productId}
    where ${pin}
      and ${canonicalVariants.status} in (${SHOPPER_VISIBLE_STATUS_LIST})
      and ${canonicalProducts.status} in (${SHOPPER_VISIBLE_STATUS_LIST})
  )`;
}

/**
 * The comparison read: active offers on a variant (or on every variant of a
 * product), cheapest first.
 *
 * The product form is a SEMI-JOIN through `canonical_variants` rather than a
 * denormalized product id on the offer — a product's variant count is small and
 * indexed, so the join is cheap, and the alternative is a second representation
 * a variant merge could put out of step (see the schema's docblock).
 *
 * The keyset cursor carries the price AND the id because prices tie routinely —
 * twenty merchants at 1,199 € is the normal case, and issue acceptance 1 asks
 * for exactly that — and a cursor on price alone would loop forever on the tie.
 */
export async function listOffersForComparison(
  db: DatabaseOrTransaction,
  query: OfferComparisonQuery,
): Promise<OfferWithChannel[]> {
  const now = query.now ?? new Date();
  const sortPrice = sql`coalesce(${offers.priceAmount}, ${UNPRICED_SORT_KEY}::bigint)`;

  // ONE predicate carries both "which canonical id was asked for" and "may a
  // shopper see it". They were separate before #367 line 366 and the second did
  // not exist; folding them is what makes it impossible to ask this function for
  // a scope without also asking whether that scope may be served.
  const scope = shopperVisibleScope(query);

  const rows = await db
    .select({ offer: offers, storefrontOperatorMerchantId: storefronts.merchantId })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(
      and(
        eq(offers.status, 'active'),
        scope,
        // A market-less offer is published for everywhere, so a country filter
        // must ADMIT it. Dropping it would empty a Spanish product page of every
        // global feed's offers, which is the common case rather than an edge one.
        query.country
          ? or(eq(offers.country, query.country), isNull(offers.country))
          : undefined,
        query.kinds && query.kinds.length > 0
          ? inArray(offers.kind, [...query.kinds])
          : undefined,
        query.availability && query.availability.length > 0
          ? inArray(offers.availability, [...query.availability])
          : undefined,
        // #90: keys and segments collapse into ONE membership test. Two
        // predicates ANDed would make `?conditionKeys=used_good&
        // conditionGroups=refurbished` return nothing, which is the opposite of
        // what a facet UI sending both means.
        conditionMembership(query),
        query.excludeStale ? gt(offers.staleAt, now) : undefined,
        query.after
          ? sql`(${sortPrice}, ${offers.id}) >
                (${query.after.priceAmount ?? UNPRICED_SORT_KEY}::bigint, ${query.after.id}::text)`
          : undefined,
      ),
    )
    .orderBy(sql`${sortPrice} asc`, asc(offers.id))
    .limit(query.limit);

  return rows.map((row) => ({
    offer: row.offer,
    storefrontOperatorMerchantId: row.storefrontOperatorMerchantId,
  }));
}

/** One offer with its channel operator — the operator trace's own read. */
export async function findOfferWithChannel(
  db: DatabaseOrTransaction,
  id: string,
): Promise<OfferWithChannel | undefined> {
  const rows = await db
    .select({ offer: offers, storefrontOperatorMerchantId: storefronts.merchantId })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(eq(offers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { offer: row.offer, storefrontOperatorMerchantId: row.storefrontOperatorMerchantId };
}

/** Counts by status for one canonical variant — the operator trace's summary. */
export async function countOffersByStatusForVariant(
  db: DatabaseOrTransaction,
  canonicalVariantId: string,
): Promise<{ active: number; retired: number }> {
  const rows = await db
    .select({
      active: sql<number>`count(*) filter (where ${offers.status} = 'active')::int`,
      retired: sql<number>`count(*) filter (where ${offers.status} = 'retired')::int`,
    })
    .from(offers)
    .where(eq(offers.canonicalVariantId, canonicalVariantId));
  return { active: rows[0]?.active ?? 0, retired: rows[0]?.retired ?? 0 };
}
