/**
 * Reconciling a connected channel with the catalogue Mercaria already indexed
 * (#87 "Reconcile with existing external identity", acceptance 3).
 *
 * ## The situation
 *
 * A merchant's web shop was crawled, fed or listed on a marketplace long before
 * they heard of Mercaria, so their products are already in the graph as EXTERNAL
 * offers under a storefront. They then connect the channel, and their listings
 * begin materializing NATIVE offers against the same canonical variants. Two
 * rows now describe one real sale.
 *
 * ## What this does, and the four things it deliberately does not
 *
 * It REPORTS. `payment_discrepancies`' posture, and #84's already: something an
 * operator or a merchant can see and act on, with no destructive effect of its
 * own.
 *
 * 1. **It deletes nothing.** Reconcile requirement 3 preserves source records,
 *    clicks and price history; #84 acceptance 3 keeps both rows distinct and
 *    sharing one canonical product. Both survive, both keep their own
 *    `source_record_id` chain, and the comparison surface goes on showing what
 *    each seller published.
 * 2. **It converts nothing in place.** Reconcile requirement 4 — an external
 *    affiliate offer is somebody's observation and rewriting it into a native
 *    offer would destroy the observation while claiming to upgrade it.
 * 3. **It decides no matches.** #58 owns identity, and this module reads
 *    `native_listing_links` and `offers.canonical_variant_id` rather than
 *    forming an opinion about which product is which. `awaitingReview` is a
 *    COUNT of what #58 already routed to #59's queue.
 * 4. **It infers no relationship.** Reconcile requirement 8: a connected
 *    catalogue is not evidence of an official-brand status, and
 *    `channel-isolation.test.ts` fails the build if this domain reaches the
 *    relationship layer.
 *
 * ## Which rule demoted which row is #84's, not a second copy
 *
 * `reconcileMerchantOfferOverlaps` is a pure function with a total, deterministic
 * four-rule order. Writing a second one here — even an equivalent one — would
 * mean two answers to "which representation is primary", and the loser is
 * whichever surface a merchant happens to be looking at.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type { ChannelOverlapRow, ChannelReconciliationSummary } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findConnection } from '../../db/connectors/connectionRepository.js';
import { listings, productVariants } from '../../db/schema/catalog.js';
import { matchDecisions } from '../../db/schema/matching.js';
import { offers } from '../../db/schema/offers.js';
import { storefronts } from '../../db/schema/merchants.js';
import { notFound } from '../../lib/errors/error-codes.js';
import {
  reconcileMerchantOfferOverlaps,
  type OverlapCandidateOffer,
} from '../store-linkage/offer-overlap.js';
import { resolveChannelBinding } from './channel-binding.js';

/**
 * How many overlapping variants are examined in one pass.
 *
 * Bounded because this is a merchant-facing read on a page that must render:
 * a merchant with fifty thousand products has an interesting number of overlaps
 * and no interest in waiting for all of them. The bound is stated in the
 * response through `overlaps.length` reaching it, which is what tells a reader
 * the list is a sample rather than the total.
 */
const MAX_OVERLAP_CANDIDATES = 2_000;

/**
 * Reconcile one connection against what is already indexed for its merchant.
 *
 * A connection with no binding still answers — with the gap named, zero
 * overlaps, and the native count. Refusing would leave the commonest case (an
 * unclaimed merchant, which is every store's state until somebody claims it)
 * with a screen that reads as an error rather than as "there is nothing indexed
 * for you yet".
 */
export async function reconcileChannel(
  storeId: string,
  connectionId: string,
): Promise<ChannelReconciliationSummary> {
  const connection = await findConnection(storeId, connectionId);
  if (!connection) {
    throw notFound('Connection not found');
  }

  const binding = await resolveChannelBinding({
    storeId,
    shopDomain: connection.shopDomain,
  });

  const nativeOffers = await countNativeOffersForStore(storeId);

  if (!binding.bound) {
    return {
      storeId,
      connectionId,
      bindingGap: binding.gap,
      existingExternalOffers: 0,
      nativeOffers,
      overlaps: [],
      awaitingReview: await countAwaitingReview(storeId),
    };
  }

  // A bound merchant with no matching storefront still reconciles, at merchant
  // grain, with the gap reported beside the result. #84's overlap rules read the
  // offer's kind and its channel operator rather than a storefront id, so
  // narrowing to one storefront would only DROP the merchant's other channels
  // from the comparison — which is where a duplicate is most likely to be.
  const external = await readExternalOffersForMerchant(binding.merchantId);
  const native = await readNativeOffersForStore(storeId);

  // #84's pure function decides. The two sets are handed over together because
  // an overlap is a canonical VARIANT carrying both kinds, and grouping happens
  // inside it.
  const findings = reconcileMerchantOfferOverlaps([...external, ...native]);

  const overlaps: ChannelOverlapRow[] = findings.map((finding) => ({
    canonicalVariantId: finding.canonicalVariantId,
    primaryOfferId: finding.primaryOfferId,
    duplicateOfferId: finding.duplicateOfferId,
    rule: finding.rule,
  }));

  return {
    storeId,
    connectionId,
    merchantId: binding.merchantId,
    storefrontId: binding.storefrontId,
    bindingGap: binding.gap,
    existingExternalOffers: external.length,
    nativeOffers,
    overlaps,
    awaitingReview: await countAwaitingReview(storeId),
  };
}

/**
 * The merchant's already-indexed non-native offers.
 *
 * `sellerIsChannelOperator` is ADR 0002 D8's derived marketplace fact, computed
 * HERE from `offers.merchant_id = storefronts.merchant_id` and handed to #84's
 * pure function already resolved — which is what keeps that function unable to
 * reach the graph, and keeps the derivation in the one place that owns it. An
 * offer with no storefront is not on a channel anybody operates, so it reads
 * `false`.
 */
async function readExternalOffersForMerchant(
  merchantId: string,
): Promise<OverlapCandidateOffer[]> {
  const rows = await getDb()
    .select({
      offerId: offers.id,
      canonicalVariantId: offers.canonicalVariantId,
      kind: offers.kind,
      lastSeenAt: offers.lastSeenAt,
      channelOperatorId: storefronts.merchantId,
    })
    .from(offers)
    .leftJoin(storefronts, eq(storefronts.id, offers.storefrontId))
    .where(
      and(
        eq(offers.merchantId, merchantId),
        eq(offers.status, 'active'),
        ne(offers.kind, 'native'),
      ),
    )
    .limit(MAX_OVERLAP_CANDIDATES);

  return rows.map((row) => ({
    offerId: row.offerId,
    canonicalVariantId: row.canonicalVariantId,
    kind: row.kind,
    sellerIsChannelOperator: row.channelOperatorId === merchantId,
    lastSeenAt: row.lastSeenAt,
  }));
}

/**
 * The store's own native offers, as overlap candidates.
 *
 * A native offer names no merchant (`offers_kind_shape_check` forces
 * `merchant_id` NULL on that kind), so it is reached through its LISTING's store
 * instead. `sellerIsChannelOperator` is `true` by construction: the channel a
 * native offer sits on is Mercaria, operated by the seller themselves — and
 * #84's rule 1 short-circuits on `native` before the flag is ever read, so this
 * is a statement of fact rather than a thumb on the scale.
 */
async function readNativeOffersForStore(storeId: string): Promise<OverlapCandidateOffer[]> {
  const rows = await getDb()
    .select({
      offerId: offers.id,
      canonicalVariantId: offers.canonicalVariantId,
      kind: offers.kind,
      lastSeenAt: offers.lastSeenAt,
    })
    .from(offers)
    .innerJoin(listings, eq(listings.id, offers.listingId))
    .where(
      and(eq(listings.storeId, storeId), eq(offers.status, 'active'), eq(offers.kind, 'native')),
    )
    .limit(MAX_OVERLAP_CANDIDATES);

  return rows.map((row) => ({
    offerId: row.offerId,
    canonicalVariantId: row.canonicalVariantId,
    kind: row.kind,
    sellerIsChannelOperator: true,
    lastSeenAt: row.lastSeenAt,
  }));
}

/** How many active native offers this store currently materializes. */
export async function countNativeOffersForStore(storeId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(offers)
    .innerJoin(listings, eq(listings.id, offers.listingId))
    .where(
      and(eq(listings.storeId, storeId), eq(offers.status, 'active'), eq(offers.kind, 'native')),
    );
  return row?.total ?? 0;
}

/**
 * How many of this store's listings are waiting on a person to confirm a match.
 *
 * #58 routes a heuristic attachment to #59's review queue; #87 reconcile 6 asks
 * that the merchant be able to REVIEW uncertain matches, and the first half of
 * that is being told there are any. The count is a pointer at the queue, not a
 * second queue — this domain has no route that decides one.
 */
export async function countAwaitingReview(storeId: string): Promise<number> {
  // `match_decisions` names a VARIANT, not a listing — a decision is about one
  // purchasable configuration — so the store is reached through the variant's
  // parent. `review_state = 'pending'` is #58's own predicate for its queue, and
  // it is served by `match_decisions_review_pending_idx`, which is partial on
  // exactly that value.
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(matchDecisions)
    .innerJoin(productVariants, eq(productVariants.id, matchDecisions.productVariantId))
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(and(eq(listings.storeId, storeId), eq(matchDecisions.reviewState, 'pending')));
  return row?.total ?? 0;
}

/**
 * How many external offers this store's merchant has that a disconnect leaves
 * standing.
 *
 * Read by the disconnect result so a merchant can see that their price history
 * survived. Zero for an unbound store, which is the truth: nothing is indexed
 * under a merchant that does not exist.
 */
export async function countPreservedExternalOffers(storeId: string): Promise<number> {
  const binding = await resolveChannelBinding({ storeId, shopDomain: undefined });
  if (!binding.bound) return 0;
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(offers)
    .where(
      and(
        eq(offers.merchantId, binding.merchantId),
        eq(offers.status, 'active'),
        ne(offers.kind, 'native'),
      ),
    );
  return row?.total ?? 0;
}
