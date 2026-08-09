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
import { conditionKeysInGroup } from '@mercaria/shared-types';
import type {
  ConditionGroup,
  OfferAvailability,
  OfferConditionKey,
  OfferKind,
  OfferRetirementReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { offers } from '../schema/offers.js';
import { storefronts } from '../schema/merchants.js';

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
      targetWhere: sql`${offers.status} = 'active' and ${offers.externalOfferId} is not null`,
      set: {
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
 * Retire every ACTIVE EXTERNAL offer whose own TTL has passed (issue external
 * rule 3).
 *
 * NATIVE offers are deliberately excluded, and the exclusion is the decision
 * rather than an oversight. A native offer's `stale_at` measures how long ago
 * the CONVERGER last touched it, not a source's own validity window — so a
 * dispatcher outage would otherwise delist a healthy catalogue on a clock. The
 * issue scopes this sweep to external sources in as many words, and native
 * staleness is a DISPLAY signal (`stale_observation`) that changes nothing about
 * whether the listing is buyable, which the live checkout derivation answers.
 *
 * Bounded and resumable by construction: it takes a `limit` and orders by the
 * deadline, so a sweep over a backlog makes progress in chunks a lease can
 * finish rather than in one statement that holds locks for minutes.
 */
export async function retireLapsedExternalOffers(
  db: DatabaseOrTransaction,
  limit: number,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(offers)
    .set({ status: 'retired', retirementReason: 'source_expired', retiredAt: now })
    .where(
      sql`${offers.id} in (
        select ${offers.id} from ${offers}
        where ${and(eq(offers.status, 'active'), ne(offers.kind, 'native'), lte(offers.staleAt, now))}
        order by ${asc(offers.staleAt)}
        limit ${limit}
      )`,
    )
    .returning({ id: offers.id });
  return rows.length;
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

  const scope = query.canonicalVariantId
    ? eq(offers.canonicalVariantId, query.canonicalVariantId)
    : sql`${offers.canonicalVariantId} in (
        select ${canonicalVariants.id} from ${canonicalVariants}
        where ${eq(canonicalVariants.productId, query.canonicalProductId ?? '')}
      )`;

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
