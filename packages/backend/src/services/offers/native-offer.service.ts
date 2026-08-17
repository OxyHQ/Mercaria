/**
 * Native offer materialization (#57 native rules 1–5, ADR 0002 D18).
 *
 * Every active native `Listing` variant that is attached to a canonical variant
 * materializes a native offer; nothing else does. The offer REFERENCES the
 * listing — it does not copy its lifecycle into a second authority — so this
 * service's whole job is to keep the COMPARISON facts (price, availability,
 * condition, the seller's own words) in step, and never to decide whether
 * anything may be bought. That question is answered live, at read time, by
 * `deriveNativeCheckoutEligibility`.
 *
 * ## Convergence, not events
 *
 * {@link convergeNativeOffersForListing} computes a FIXED POINT: it reads the
 * listing, its variants and their canonical attachments as they are right now,
 * and makes the offer rows say exactly that. Running it twice changes nothing
 * the second time, running it after three writes answers all three, and running
 * it against a listing that was deleted mid-flight is a no-op. That is what lets
 * the queue coalesce (one outbox row per listing) and what makes a redelivery,
 * a reclaimed lease and an operator's manual re-run all safe.
 *
 * ## Why a native offer's price is a projection at all
 *
 * ADR 0002 D18: the AUTHORITY is the variant, and checkout never reads offers.
 * A stale native offer can therefore mis-DISPLAY and can never mis-CHARGE. The
 * duplication buys one uniform comparison read across native and external
 * offers, which is the entire reason the offer model is unified.
 */

import type { OfferAvailability, OfferQualitySignal } from '@mercaria/shared-types';
import { declaredOfferCondition } from '../condition/condition-mapping.service.js';
import { narrowStoredCondition } from '../condition/condition-projection.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findListingById, type ListingRecord } from '../../db/catalog/listingRepository.js';
import { findVariantsByListing, type VariantRecord } from '../../db/catalog/variantRepository.js';
import { findActiveLinksForListing } from '../../db/offers/nativeListingLinkRepository.js';
import {
  findOffersForListing,
  retireOffers,
  upsertNativeOffer,
  type InsertOfferInput,
} from '../../db/offers/offerRepository.js';
import { enqueueOfferConvergence } from '../../db/offers/offerOutboxRepository.js';
// Price history (#78) — the observation this convergence produced. The ONLY
// import of that domain from here, and it runs in the caller's transaction.
import { recordOfferPriceObservation } from '../price-history/record.service.js';
// Price alerts (#79) — the second of the two offer-change chokepoints. See the
// note beside the call, and `offer.service.ts` for the same one.
import { requestPriceAlertEvaluation } from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import { requestShoppingAgentTrigger } from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';
import { log } from '../../lib/logger.js';

/**
 * How long a native projection is considered current before it reads `aging`
 * and then `stale`.
 *
 * A native offer has no source with a validity window, so this measures how long
 * ago the CONVERGER last touched it — which is a real fact worth surfacing (a
 * dispatcher that stopped shows up as a catalogue going stale) and is
 * deliberately NOT a reason to retire anything: `retireLapsedExternalOffers`
 * excludes native offers for exactly that reason.
 */
export const NATIVE_OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** The listing statuses a native offer may exist for. Only one, and that is the point. */
const OFFERABLE_LISTING_STATUS = 'active';

/**
 * Ask for a listing's native offers to be brought back into agreement with it.
 *
 * Fire-and-forget from the caller's point of view and DURABLE from the
 * database's: the row is the job, so a task that dies between this call and the
 * convergence leaves the work claimable by another. Pass the caller's
 * transaction when there is one, so a rolled-back catalogue write does not leave
 * a request for a change that never happened.
 *
 * The handle is REQUIRED (#584), and this wrapper is where that matters more
 * than at the repository. `enqueueOfferConvergence`'s own default was the
 * reported defect, but every caller who could omit one reaches it through HERE —
 * so leaving `db?` in place would have moved the omission one frame up and
 * changed nothing: `db ?? getDb()` is a default wearing a different spelling. A
 * caller outside a transaction passes `getDb()` and says so.
 *
 * It matters more here for a second reason: the catch below. An enqueue on the
 * root connection from inside the transaction that CREATES the listing raises
 * `23503` on `offer_outboxes_listing_id_listings_id_fk`, and this wrapper
 * swallows it — so even the shape that fails CLOSED at the database arrives as a
 * WARN line nobody reads.
 *
 * Failures are logged and swallowed. A catalogue write must not fail because a
 * comparison projection could not be QUEUED — the listing is the authority, the
 * offer is a projection of it, and the next write to that listing enqueues
 * again. This is the one place in the domain where that trade is made, and it is
 * made here rather than at each of the call sites so it is one decision. It is
 * also why `catalog-authoring/publish.service.ts` calls the REPOSITORY directly:
 * inside a transaction a swallowed error leaves every later statement failing on
 * a poisoned transaction (`25P02`).
 */
export async function requestNativeOfferSync(
  listingId: string,
  db: DatabaseOrTransaction,
): Promise<void> {
  try {
    await enqueueOfferConvergence(listingId, db);
  } catch (err) {
    log.general.warn({ err, listingId }, '[Offers] failed to enqueue native offer convergence');
  }
}

/**
 * What a variant's stock says about availability.
 *
 * An UNTRACKED variant is available — the catalogue's own `hasInventory` rule
 * treats it that way, and a P2P listing that never declared a count sells fine
 * today. Reading `inventoryAvailable` without that guard would mark every one of
 * them out of stock.
 */
function availabilityFor(variant: VariantRecord): OfferAvailability {
  if (!variant.inventoryTracked) return 'in_stock';
  return variant.inventoryAvailable > 0 ? 'in_stock' : 'out_of_stock';
}

/**
 * The quantity, present ONLY when the seller actually declares one.
 *
 * An untracked variant supplies no count, so the column stays NULL rather than
 * taking a zero — the same "unknown is not zero" rule the delivery columns
 * follow, applied to stock (issue commercial fact 3).
 */
function availableQuantityFor(variant: VariantRecord): number | null {
  return variant.inventoryTracked ? variant.inventoryAvailable : null;
}

/** The signals a native projection can honestly carry about its own inputs. */
function qualitySignalsFor(variant: VariantRecord): OfferQualitySignal[] {
  const signals: OfferQualitySignal[] = [];
  if (variant.priceAmount === null) signals.push('missing_price');
  // A native offer never publishes delivery facts: Moovo owns shipping and
  // Mercaria has no rates to state. Saying so is what stops a ranking reading
  // the silence as free delivery (issue acceptance 4).
  signals.push('unknown_delivery');
  return signals;
}

/** The row a variant's native offer should be, given the listing it belongs to. */
function desiredNativeOffer(
  listing: ListingRecord,
  variant: VariantRecord,
  canonicalVariantId: string,
  now: Date,
): InsertOfferInput {
  return {
    kind: 'native',
    status: 'active',
    canonicalVariantId,
    productVariantId: variant.id,
    listingId: listing.id,
    priceAmount: variant.priceAmount,
    priceCurrency: variant.priceCurrency,
    compareAtPriceAmount: variant.compareAtPriceAmount,
    compareAtPriceCurrency: variant.compareAtPriceCurrency,
    availability: availabilityFor(variant),
    availableQuantity: availableQuantityFor(variant),
    // #90: a native offer projects a listing Mercaria already holds, so its
    // condition is a FIRST-PARTY DECLARATION — no source label, no confidence,
    // no ruleset. `declaredOfferCondition` produces exactly the column
    // combination the `offers_condition_declared_shape_check` CHECK admits,
    // which is why the converger builds it from one helper rather than setting
    // five columns by hand at each of its call sites.
    ...declaredOfferCondition(narrowStoredCondition(listing.condition)),
    sellerSku: variant.sku,
    merchantTitle: listing.title,
    merchantVariantText: variant.title,
    observedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    lastConfirmedAt: now,
    staleAt: new Date(now.getTime() + NATIVE_OFFER_TTL_MS),
    qualitySignals: qualitySignalsFor(variant),
  };
}

/** What one convergence run did, for the dispatcher's log and the operator trace. */
export interface NativeOfferConvergenceResult {
  listingId: string;
  /** Offers created or refreshed. */
  materialized: number;
  /** Offers retired because the listing is no longer offerable. */
  retiredForListing: number;
  /** Offers retired because their variant or its canonical attachment is gone. */
  retiredForVariant: number;
}

/**
 * Bring one listing's native offers into agreement with the listing.
 *
 * Runs in ONE transaction, so a comparison read never sees a listing with half
 * its offers retired. The three outcomes are distinguished on purpose:
 *
 * - the listing is gone, or is not `active` (draft, sold, archived, RESTRICTED)
 *   ⇒ every one of its offers retires as `listing_unpublished`. This is issue
 *   native rule 5 and acceptance 6, and it is why the moderation enforcement
 *   path enqueues here;
 * - a variant that no longer exists, or whose canonical attachment was revoked
 *   ⇒ that offer retires as `variant_removed`, and its siblings are untouched;
 * - everything else ⇒ upserted, converging on the active-native unique.
 *
 * A variant with NO canonical attachment materializes NOTHING, and that is not a
 * failure: an offer prices a canonical variant, so a native variant nobody has
 * matched yet has nothing to be an offer ON. #58's matcher attaches it later and
 * the next convergence materializes it.
 */
export async function convergeNativeOffersForListing(
  listingId: string,
  now: Date = new Date(),
): Promise<NativeOfferConvergenceResult> {
  return getDb().transaction((tx) => convergeInTransaction(listingId, now, tx));
}

async function convergeInTransaction(
  listingId: string,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<NativeOfferConvergenceResult> {
  const listing = await findListingById(listingId, db);
  const existing = await findOffersForListing(db, listingId);
  const activeExisting = existing.filter((offer) => offer.status === 'active');

  // A deleted listing has already taken its offers with it (both foreign keys
  // CASCADE), so there is nothing left to retire — and an unpublished one
  // retires everything without needing to look at a single variant.
  if (!listing || listing.status !== OFFERABLE_LISTING_STATUS) {
    const retired = await retireOffers(
      db,
      activeExisting.map((offer) => offer.id),
      'listing_unpublished',
      now,
    );
    return { listingId, materialized: 0, retiredForListing: retired, retiredForVariant: 0 };
  }

  const variants = await findVariantsByListing(listingId, db);
  const links = await findActiveLinksForListing(db, listingId);
  const canonicalByVariant = new Map(links.map((link) => [link.productVariantId, link.canonicalVariantId]));

  let materialized = 0;
  const keptVariantIds = new Set<string>();

  for (const variant of variants) {
    const canonicalVariantId = canonicalByVariant.get(variant.id);
    if (!canonicalVariantId) continue;
    const offer = await upsertNativeOffer(
      db,
      desiredNativeOffer(listing, variant, canonicalVariantId, now),
    );
    /**
     * The price observation (#78), in the SAME transaction as the convergence.
     *
     * A native offer is `current` and UNBOUNDED by #68's own rule — its
     * `stale_at` measures how long ago this converger ran, not how long the
     * price is trustworthy — so the level recorded here is `current` and is not
     * computed from a deadline that means something else.
     *
     * The write deduplicates itself: a convergence that changed nothing writes
     * no observation until the anchor interval has passed, which matters
     * because this path runs on every listing edit, every stock movement and
     * every moderation action.
     */
    await recordOfferPriceObservation(db, offer, {
      observedAt: now,
      freshnessLevel: 'current',
    });
    // #79's durable offer-change event, in the same transaction. Converges on
    // one row per PRODUCT, so a listing with forty variants owes one evaluation.
    await requestPriceAlertEvaluation(offer.canonicalVariantId, db, now);
  // #97's saved agents, beside #79's alerts and gated the same way: the first
  // statement is one indexed `exists`, so a product nobody watches writes no
  // row. Both run in the CALLER's transaction — a queue row that committed for
  // an offer write that rolled back would wake an agent about a price that
  // never existed.
  await requestShoppingAgentTrigger(offer.canonicalVariantId, db, now);
    keptVariantIds.add(variant.id);
    materialized += 1;
  }

  // Whatever was active and is not in the desired set: a deleted variant (whose
  // offer would have cascaded, so this is the attachment case) or one whose
  // canonical link was revoked. Its siblings stay exactly as they are.
  const orphaned = activeExisting.filter(
    (offer) => !offer.productVariantId || !keptVariantIds.has(offer.productVariantId),
  );
  const retiredForVariant = await retireOffers(
    db,
    orphaned.map((offer) => offer.id),
    'variant_removed',
    now,
  );

  return { listingId, materialized, retiredForListing: 0, retiredForVariant };
}
