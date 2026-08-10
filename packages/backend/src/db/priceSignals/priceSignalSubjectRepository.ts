/**
 * The three narrow reads #82 needs from tables it does not own.
 *
 * Each is a PROJECTION naming every column it selects, the `provider_accounts`
 * rule: a `select()` over `offers` would put a source record id, an affiliate
 * routing template and a destination URL into a domain whose whole output is
 * shown to a competitor's rival, and a projection that names its columns cannot
 * acquire one by somebody adding a column upstream.
 */

import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { merchants } from '../schema/merchants.js';
import { offers } from '../schema/offers.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';

/** Who is SELLING behind one offer — the two ids `sellerDedupKey` reads. */
export interface OfferSellerIdentity {
  readonly merchantId: string | null;
  readonly listingId: string | null;
}

/**
 * The seller identity behind a set of offers, including RETIRED ones.
 *
 * Historical points name offers that may no longer be active, so this cannot be
 * answered from the current comparison page — and a point whose seller could not
 * be resolved must be excluded from the sample rather than counted as a seller of
 * its own, which is `sellerDedupKey`'s rule and the reason this read exists at
 * all.
 */
export async function listOfferSellerIdentities(
  offerIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, OfferSellerIdentity>> {
  if (offerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: offers.id, merchantId: offers.merchantId, listingId: offers.listingId })
    .from(offers)
    .where(inArray(offers.id, [...offerIds]));
  return new Map(
    rows.map((row) => [row.id, { merchantId: row.merchantId, listingId: row.listingId }]),
  );
}

/**
 * The Oxy account that VERIFIABLY operates a merchant, or `null`.
 *
 * #83's `merchants.claim_state` is the one stored verdict and this read is the
 * whole of the competitiveness surface's authorization: an unclaimed merchant, a
 * pending claim and a revoked one all answer `null`, and the route then answers
 * 404 rather than 403 — a distinguishable refusal would let anybody enumerate
 * which merchants have been claimed.
 *
 * A revocation returns the merchant to `unclaimed` with no claimant (#83), so
 * this surface disappears with the claim and needs no sweep to notice.
 */
export async function findVerifiedMerchantClaimant(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const rows = await db
    .select({ claimState: merchants.claimState, claimedByOxyUserId: merchants.claimedByOxyUserId })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  // `'claimed'` is #83's VERIFIED terminal state — `CLAIM_STATES` is
  // `unclaimed | claim_pending | claimed`, and the partial unique
  // `(merchant_id) WHERE state = 'verified'` on `merchant_claims` is what makes
  // exactly one claimant able to reach it. Reading the CLAIM table instead would
  // be a second authority over the one stored verdict ADR 0002 D9 names.
  if (row.claimState !== 'claimed') return null;
  return row.claimedByOxyUserId;
}

/** One canonical subject a merchant sells on. */
export interface MerchantOfferSubject {
  readonly offerId: string;
  readonly canonicalVariantId: string;
  readonly canonicalProductId: string | null;
  readonly market: string | null;
  /**
   * The offer's OWN declared condition and listed currency (#86).
   *
   * They are here so an aggregate over a merchant's subjects can evaluate each
   * one in the segment and currency the MERCHANT priced it in, rather than in a
   * segment and currency somebody chose on their behalf. `readMerchantCompetitiveness`
   * does not read them: it answers a per-(segment, currency) question the caller
   * asked, which is a different question.
   */
  readonly condition: string;
  readonly priceCurrency: string | null;
}

/**
 * The canonical variants a merchant has offers on, keyset-paged.
 *
 * ACTIVE offers only is deliberately NOT the filter: competitiveness item 3 is
 * "products LOSING eligibility", and an offer a freshness contract already
 * retired is exactly the one a merchant needs to be told about. The eligibility
 * verdict is #74's and is taken later, over the whole set.
 */
export async function listMerchantOfferSubjects(
  input: { readonly merchantId: string; readonly afterOfferId?: string; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantOfferSubject[]> {
  const rows = await db
    .select({
      offerId: offers.id,
      canonicalVariantId: offers.canonicalVariantId,
      canonicalProductId: canonicalVariants.productId,
      market: offers.country,
      condition: offers.condition,
      priceCurrency: offers.priceCurrency,
    })
    .from(offers)
    .leftJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .where(
      and(
        eq(offers.merchantId, input.merchantId),
        isNotNull(offers.canonicalVariantId),
        input.afterOfferId === undefined ? undefined : gt(offers.id, input.afterOfferId),
      ),
    )
    .orderBy(asc(offers.id))
    .limit(input.limit);
  return rows;
}
