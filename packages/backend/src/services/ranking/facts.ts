/**
 * The live facts one comparison reads, gathered ONCE per page (#74).
 *
 * `offer.service.ts`'s `buildOfferProjectionContext` is the shape this follows
 * and the reason is the same: a twenty-offer comparison must not become eighty
 * round trips, and a fact read per row is a fact that can differ between two
 * offers in one list. Five batched reads regardless of how many offers there
 * are — merchant standing, storefront standing, merchant review aggregates, the
 * subject's verified relationships, and the source each observation came from.
 *
 * ## What is NOT here, and could not be
 *
 * No fee, no referral, no commission, no plan, no margin and no popularity
 * count. `OfferRankingFacts` has no field for one, so there is nothing for a
 * query here to fill — and `offer-ranking-isolation.test.ts` fails the build if
 * this module learns to import the domain that holds any of them. The absence is
 * the enforcement; this comment only says so out loud.
 *
 * ## The relationship read is ONE query for the whole page
 *
 * `resolveOfficialChannel` answers for one merchant, and a page has many. So the
 * brand's current verified relationships are read once through the same
 * repository that surface uses and indexed by merchant — never by asking #55 per
 * offer, which would be the same answer N times and would make the comparison's
 * cost a function of how many merchants sell the product.
 */

import type {
  ConditionGroup,
  ItemConditionKey,
  CurrencyCode,
  FxRates,
  Offer,
  OfferRankingFacts,
  OfferRelationshipStanding,
} from '@mercaria/shared-types';
import { eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants, storefronts } from '../../db/schema/merchants.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';
import { findAggregatesForTargets } from '../../db/reviews/reviewAggregateRepository.js';
import { convertOfferMoney, composeComparisonTotal } from './money.js';
import { resolveOfferTaxInclusion, resolvePickupProximity } from './seams.js';

/**
 * Statuses that WITHDRAW a merchant or storefront from comparison (rule 10).
 *
 * `merged` is deliberately absent. A merged entity is a tombstone pointing at
 * its winner, so excluding its offers would hide live inventory in order to hide
 * a redirect — the treatment a tombstone gets everywhere else in this graph.
 *
 * (The wording avoids naming the table another domain's gate greps for: this
 * file is on that gate's scanned list, it scans raw source, and a COMMENT that
 * trips it is a false positive somebody would eventually silence by weakening
 * the pattern. Rewording one comment is cheaper than a weaker gate.)
 */
const SUPPRESSED_ENTITY_STATUSES = ['suppressed', 'inactive'] as const;

/** Everything a page's facts are built from, read once. */
export interface RankingFactContext {
  readonly comparisonCurrency: CurrencyCode;
  readonly rates: FxRates;
  readonly suppressedMerchantIds: ReadonlySet<string>;
  readonly suppressedStorefrontIds: ReadonlySet<string>;
  /** Merchant id → its verified standing with the subject's brand (#55). */
  readonly relationships: ReadonlyMap<string, OfferRelationshipStanding>;
  /** Whether the subject resolved to a brand at all — `false` makes it UNKNOWN. */
  readonly brandResolved: boolean;
  /** Merchant id → `{rating, count}` over VERIFIED reviews (#76). */
  readonly merchantRatings: ReadonlyMap<string, { rating: number; count: number }>;
  /** Source-record id → the catalogue source it came from, for dominance. */
  readonly offerSourceIds: ReadonlyMap<string, string>;
  readonly viewerLatitude?: number;
  readonly viewerLongitude?: number;
  readonly now: Date;
}

/**
 * Read the page's facts.
 *
 * `brandId` is resolved from the comparison SUBJECT rather than from the offers:
 * a relationship is a claim about a merchant and a brand, and taking the brand
 * from whichever offer happened to be first would make the answer depend on the
 * ordering it is an input to.
 */
export async function buildRankingFactContext(input: {
  readonly offers: readonly Offer[];
  readonly comparisonCurrency: CurrencyCode;
  readonly rates: FxRates;
  readonly market?: string;
  readonly viewerLatitude?: number;
  readonly viewerLongitude?: number;
  readonly now?: Date;
  readonly db?: DatabaseOrTransaction;
}): Promise<RankingFactContext> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  const merchantIds = [
    ...new Set(input.offers.flatMap((offer) => (offer.merchantId ? [offer.merchantId] : []))),
  ];
  const storefrontIds = [
    ...new Set(input.offers.flatMap((offer) => (offer.storefrontId ? [offer.storefrontId] : []))),
  ];
  const sourceRecordIds = [
    ...new Set(
      input.offers.flatMap((offer) =>
        offer.provenance.sourceRecordId ? [offer.provenance.sourceRecordId] : [],
      ),
    ),
  ];
  const canonicalVariantIds = [...new Set(input.offers.map((offer) => offer.canonicalVariantId))];

  const suppressedMerchantIds = new Set<string>();
  if (merchantIds.length > 0) {
    const rows = await db
      .select({ id: merchants.id, status: merchants.status })
      .from(merchants)
      .where(inArray(merchants.id, merchantIds));
    for (const row of rows) {
      if ((SUPPRESSED_ENTITY_STATUSES as readonly string[]).includes(row.status)) {
        suppressedMerchantIds.add(row.id);
      }
    }
  }

  const suppressedStorefrontIds = new Set<string>();
  if (storefrontIds.length > 0) {
    const rows = await db
      .select({ id: storefronts.id, status: storefronts.status })
      .from(storefronts)
      .where(inArray(storefronts.id, storefrontIds));
    for (const row of rows) {
      if ((SUPPRESSED_ENTITY_STATUSES as readonly string[]).includes(row.status)) {
        suppressedStorefrontIds.add(row.id);
      }
    }
  }

  const offerSourceIds = new Map<string, string>();
  if (sourceRecordIds.length > 0) {
    const rows = await db
      .select({ id: sourceRecords.id, sourceId: sourceRecords.sourceId })
      .from(sourceRecords)
      .where(inArray(sourceRecords.id, sourceRecordIds));
    for (const row of rows) offerSourceIds.set(row.id, row.sourceId);
  }

  const merchantRatings = new Map<string, { rating: number; count: number }>();
  if (merchantIds.length > 0) {
    const aggregates = await findAggregatesForTargets('merchant', 'merchant', merchantIds, db);
    for (const aggregate of aggregates) {
      if (aggregate.merchantId === null) continue;
      // The VERIFIED figures only. #76 keeps two column pairs precisely so they
      // are never blended, and a ranking that read the unverified mean would be
      // ranking on reviews nobody had to buy anything to leave.
      merchantRatings.set(aggregate.merchantId, {
        rating: aggregate.rating,
        count: aggregate.reviewCount,
      });
    }
  }

  const brandId = await resolveSubjectBrandId(canonicalVariantIds, db);
  const relationships = new Map<string, OfferRelationshipStanding>();
  if (brandId !== null) {
    const rows = await findCurrentRelationships(db, {
      kinds: ['merchant_official_channel_for_brand', 'merchant_authorized_reseller_for_brand'],
      brandId,
      ...(input.market === undefined ? {} : { market: input.market.toUpperCase() }),
      at: now,
    });
    for (const row of rows) {
      if (row.merchantId === null) continue;
      const standing: OfferRelationshipStanding =
        row.kind === 'merchant_official_channel_for_brand'
          ? 'official_channel'
          : 'authorized_reseller';
      // A merchant holding both claims reads as the STRONGER one, which is
      // `resolveOfficialChannel`'s own rule: under-claiming is the safe
      // direction, and calling a brand's own store a reseller understates a true
      // relationship where the reverse asserts one that does not exist.
      if (relationships.get(row.merchantId) === 'official_channel') continue;
      relationships.set(row.merchantId, standing);
    }
  }

  return {
    comparisonCurrency: input.comparisonCurrency,
    rates: input.rates,
    suppressedMerchantIds,
    suppressedStorefrontIds,
    relationships,
    brandResolved: brandId !== null,
    merchantRatings,
    offerSourceIds,
    ...(input.viewerLatitude === undefined ? {} : { viewerLatitude: input.viewerLatitude }),
    ...(input.viewerLongitude === undefined ? {} : { viewerLongitude: input.viewerLongitude }),
    now,
  };
}

/**
 * The brand the comparison is about, or `null`.
 *
 * `null` when the variants resolve to more than one brand as well as when they
 * resolve to none: a relationship claim is about ONE brand, and picking one of
 * several would answer a question about a different product. The consequence is
 * that the relationship signal reads UNKNOWN, which is neutral — never a zero
 * against every merchant on a page whose subject nobody could pin down.
 */
async function resolveSubjectBrandId(
  canonicalVariantIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<string | null> {
  if (canonicalVariantIds.length === 0) return null;
  const rows = await db
    .select({ brandId: canonicalProducts.brandId })
    .from(canonicalVariants)
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(inArray(canonicalVariants.id, [...canonicalVariantIds]));

  const brands = new Set(rows.flatMap((row) => (row.brandId === null ? [] : [row.brandId])));
  const [only] = [...brands];
  return brands.size === 1 && only !== undefined ? only : null;
}

/**
 * Build the facts for ONE offer, from the page's context.
 *
 * Pure given the context, which is what lets `selectEligibleOffers` take it as a
 * callback and build facts only for the offers it admits — a restricted
 * listing's merchant rating is not something this surface should be reading.
 */
export function buildOfferRankingFacts(offer: Offer, context: RankingFactContext): OfferRankingFacts {
  const itemPrice = convertOfferMoney(offer.price, context.comparisonCurrency, context.rates);
  const deliveryCost = convertOfferMoney(
    offer.delivery.known ? offer.delivery.cost : undefined,
    context.comparisonCurrency,
    context.rates,
  );

  const rating = offer.merchantId === undefined ? undefined : context.merchantRatings.get(offer.merchantId);
  const pickup = resolvePickupProximity({
    offerId: offer.id,
    pickupAvailable: offer.delivery.pickup === 'available',
    ...(context.viewerLatitude === undefined ? {} : { viewerLatitude: context.viewerLatitude }),
    ...(context.viewerLongitude === undefined ? {} : { viewerLongitude: context.viewerLongitude }),
  });

  const condition: ItemConditionKey | undefined =
    offer.condition.key === 'unknown' ? undefined : offer.condition.key;
  const conditionGroup: ConditionGroup | undefined = offer.condition.group;
  const elapsed = elapsedFraction(offer);

  return {
    itemPrice,
    deliveryCost,
    total: composeComparisonTotal(itemPrice, deliveryCost),
    taxInclusion: resolveOfferTaxInclusion(),
    ...(offer.delivery.known && offer.delivery.maxDays !== undefined
      ? { deliveryMaxDays: offer.delivery.maxDays }
      : {}),
    ...(condition === undefined ? {} : { condition }),
    ...(conditionGroup === undefined ? {} : { conditionGroup }),
    ...(rating === undefined ? {} : { merchantRating: rating.rating, merchantReviewCount: rating.count }),
    ...(offer.returnPolicy?.windowDays === undefined
      ? {}
      : { returnWindowDays: offer.returnPolicy.windowDays }),
    availability: offer.availability,
    ...(elapsed === null ? {} : { freshnessElapsedFraction: elapsed }),
    ...(context.brandResolved
      ? {
          relationship:
            offer.merchantId === undefined
              ? 'none'
              : (context.relationships.get(offer.merchantId) ?? 'none'),
        }
      : {}),
    ...(pickup.known ? { pickupDistanceMetres: pickup.metres } : {}),
    nativeCheckoutEligible: offer.checkout.eligible === true,
  };
}

/**
 * How far through its own source lifetime an observation is, 0–1.
 *
 * `null` for a freshness verdict with no BOUNDED deadline — a native offer,
 * whose `stale_at` measures how long ago the convergence dispatcher ran rather
 * than anything about the seller (#68). Measuring it on that clock would make
 * dispatcher latency a ranking input, and it would move native offers in one
 * direction, which is precisely the hidden preference this issue forbids.
 */
function elapsedFraction(offer: Offer): number | null {
  const freshness = offer.freshness;
  if (freshness.level !== 'current' && freshness.level !== 'warning') return null;
  if (!freshness.expiry.bounded) return null;

  const lastSeen = Date.parse(freshness.lastSeenAt);
  const expiresAt = Date.parse(freshness.expiry.expiresAt);
  const lifetimeMs = expiresAt - lastSeen;
  if (!(lifetimeMs > 0)) return null;
  return Math.min(Math.max((freshness.checkedAgeSeconds * 1_000) / lifetimeMs, 0), 1);
}

/**
 * The dominance axes one offer sits on.
 *
 * Three, and the merchant one is unconditional on purpose: a merchant selling
 * through its own site carries no storefront row, so gating this on a resolved
 * channel operator would make exactly the direct sellers invisible to the
 * concentration check — a gap in the safe-LOOKING direction, since a report that
 * finds nothing reads identically to a market that is not concentrated.
 */
export function dominanceSubjectFor(
  offer: Offer,
  context: RankingFactContext,
): {
  readonly offerId: string;
  readonly sourceId?: string;
  readonly merchantId?: string;
  readonly affiliateNetwork?: string;
} {
  const sourceId =
    offer.provenance.sourceRecordId === undefined
      ? undefined
      : context.offerSourceIds.get(offer.provenance.sourceRecordId);
  return {
    offerId: offer.id,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(offer.merchantId === undefined ? {} : { merchantId: offer.merchantId }),
    ...(offer.affiliate?.network === undefined ? {} : { affiliateNetwork: offer.affiliate.network }),
  };
}
