/**
 * The offer READ surface, and the external-observation write (#57).
 *
 * ## The read gathers LIVE facts, once per page
 *
 * `hydrateOffers` collects the listing ids, variant ids and seller keys the
 * page's native offers refer to, reads each set in ONE query, and hands them to
 * the pure projection. That is the whole of "a moderation or inventory change
 * cannot leave a buyable stale offer" (issue acceptance 6): the buyability
 * verdict is computed from `listings.status` and `product_variants` as they are
 * at the moment of the read, so the outbox's latency can make an offer's PRICE
 * stale and can never make a restricted listing purchasable.
 *
 * ## The write never touches canonical facts
 *
 * `recordExternalOffer` writes an offer row and nothing else. It cannot mint,
 * rename or re-point a canonical product or variant — it takes a
 * `canonicalVariantId` it was GIVEN and stores it. That is issue external rule
 * 5 ("a source can update merchant title and price without overwriting canonical
 * product facts") made structural: there is no code path from here into the
 * canonical write services, and `offer-isolation.test.ts` fails the build if one
 * appears.
 */

import type {
  ConditionGroup,
  ConditionMappingProviderId,
  Offer,
  OfferAvailability,
  OfferConditionKey,
  OfferKind,
  OfferPage,
  SourceFreshnessPolicy,
} from '@mercaria/shared-types';
import { mayAppearInComparison } from '@mercaria/shared-types';
import {
  mapSourceCondition,
  unmappedOfferCondition,
} from '../condition/condition-mapping.service.js';
import { eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { listings, productVariants } from '../../db/schema/catalog.js';
import { conditionMappingRulesets } from '../../db/schema/condition.js';
import {
  findOfferWithChannel,
  listOffersForComparison,
  retireOffersMissingFromSource,
  upsertExternalOffer,
  type InsertOfferInput,
  type OfferWithChannel,
} from '../../db/offers/offerRepository.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { readSellerPaymentReadiness } from '../payments/provider-account.service.js';
import { resolveSourceFreshnessPolicies } from '../offer-freshness/policy.js';
import { projectOffer, type OfferProjectionContext } from './offer-projection.js';
// Price history (#78) — the observation this offer write produced. The ONLY
// import of that domain from here, and it runs in the caller's transaction.
import { recordOfferPriceObservation } from '../price-history/record.service.js';

/** The seller key shape `checkout.service` and the payments seam already share. */
function sellerKeyForListing(row: { ownerType: string; storeId: string | null; oxyUserId: string | null }): string | null {
  if (row.ownerType === 'store' && row.storeId) return `store:${row.storeId}`;
  if (row.ownerType === 'user' && row.oxyUserId) return `user:${row.oxyUserId}`;
  return null;
}

/**
 * Read the live facts a page of offers needs, in four queries regardless of how
 * many offers there are.
 *
 * Four, and no fewer: the listing statuses, the variant stock, the sellers'
 * readiness and the sources' display rights are owned by four different domains
 * and there is no join that reaches all of them. Doing it per row instead would
 * make a twenty-offer comparison eighty round trips.
 */
export async function buildOfferProjectionContext(
  rows: readonly OfferWithChannel[],
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferProjectionContext> {
  const listingIds = [...new Set(rows.flatMap((row) => (row.offer.listingId ? [row.offer.listingId] : [])))];
  const variantIds = [
    ...new Set(rows.flatMap((row) => (row.offer.productVariantId ? [row.offer.productVariantId] : []))),
  ];
  const sourceRecordIds = [
    ...new Set(rows.flatMap((row) => (row.offer.sourceRecordId ? [row.offer.sourceRecordId] : []))),
  ];

  const listingStatuses = new Map<string, string>();
  const listingSellerKeys = new Map<string, string>();
  const variantStock = new Map<string, { inventoryTracked: boolean; inventoryAvailable: number }>();
  const sourceRights = new Map<string, { mayDisplay: boolean; attributionRequired: boolean }>();
  // #68: which SOURCE each observation came from. Gathered in the same join as
  // the rights, because the freshness contract is keyed on the source and the
  // offer only stores the observation.
  const offerSourceIds = new Map<string, string>();

  if (listingIds.length > 0) {
    const listingRows = await db
      .select({
        id: listings.id,
        status: listings.status,
        ownerType: listings.ownerType,
        storeId: listings.storeId,
        oxyUserId: listings.oxyUserId,
      })
      .from(listings)
      .where(inArray(listings.id, listingIds));
    for (const row of listingRows) {
      listingStatuses.set(row.id, row.status);
      const sellerKey = sellerKeyForListing(row);
      if (sellerKey) listingSellerKeys.set(row.id, sellerKey);
    }
  }

  if (variantIds.length > 0) {
    const variantRows = await db
      .select({
        id: productVariants.id,
        inventoryTracked: productVariants.inventoryTracked,
        inventoryAvailable: productVariants.inventoryAvailable,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds));
    for (const row of variantRows) {
      variantStock.set(row.id, {
        inventoryTracked: row.inventoryTracked,
        inventoryAvailable: row.inventoryAvailable,
      });
    }
  }

  if (sourceRecordIds.length > 0) {
    const rightsRows = await db
      .select({
        recordId: sourceRecords.id,
        sourceId: sourceRecords.sourceId,
        mayDisplay: catalogSources.mayDisplay,
        attributionRequired: catalogSources.attributionRequired,
      })
      .from(sourceRecords)
      .innerJoin(catalogSources, eq(catalogSources.id, sourceRecords.sourceId))
      .where(inArray(sourceRecords.id, sourceRecordIds));
    for (const row of rightsRows) {
      sourceRights.set(row.recordId, {
        mayDisplay: row.mayDisplay,
        attributionRequired: row.attributionRequired,
      });
      offerSourceIds.set(row.recordId, row.sourceId);
    }
  }

  // #68: one freshness contract per SOURCE on the page, never per offer. A
  // page carrying forty offers from three feeds resolves three policies.
  const resolvedPolicies = await resolveSourceFreshnessPolicies([...offerSourceIds.values()], db);
  const freshnessPolicies = new Map<string, SourceFreshnessPolicy>();
  for (const [sourceId, resolved] of resolvedPolicies) {
    freshnessPolicies.set(sourceId, resolved.policy);
  }

  // #90: the ruleset row ids the page's offers cite → their VERSION numbers, in
  // one query. A DTO publishes the version because that is what an operator
  // corrects against; the row id is a key nobody outside this service can use.
  const conditionRulesetVersions = new Map<string, number>();
  const rulesetIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.offer.conditionMappingRulesetId ? [row.offer.conditionMappingRulesetId] : [],
      ),
    ),
  ];
  if (rulesetIds.length > 0) {
    const rulesetRows = await db
      .select({ id: conditionMappingRulesets.id, version: conditionMappingRulesets.version })
      .from(conditionMappingRulesets)
      .where(inArray(conditionMappingRulesets.id, rulesetIds));
    for (const row of rulesetRows) conditionRulesetVersions.set(row.id, row.version);
  }

  // The payments seam, and the ONLY thing this domain reads from that domain.
  const sellerReady = await readSellerPaymentReadiness([...new Set(listingSellerKeys.values())]);

  return {
    listingStatuses,
    listingSellerKeys,
    variantStock,
    sourceRights,
    offerSourceIds,
    freshnessPolicies,
    conditionRulesetVersions,
    sellerReady,
    now,
  };
}

/** How a caller asks for offers. Exactly one scope, validated before any query. */
export interface ListOffersInput {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  country?: string;
  kinds?: readonly OfferKind[];
  availability?: readonly OfferAvailability[];
  conditions?: readonly OfferConditionKey[];
  /** Whole condition SEGMENTS, unioned with `conditions` (#90 acceptance 2). */
  conditionGroups?: readonly ConditionGroup[];
  /** Default TRUE: a lapsed offer is excluded from current results (external rule 3). */
  includeStale?: boolean;
  limit: number;
  cursor?: string;
  now?: Date;
}

/**
 * Encode/decode the keyset cursor.
 *
 * `price:id`, with an empty price meaning "unpriced" — the sentinel the
 * repository substitutes. Opaque to the client and deliberately not base64:
 * an encoding that only LOOKS opaque invites somebody to decode and hand-craft
 * one, and the repository validates the parts anyway.
 */
function encodeCursor(offer: { priceAmount: number | null; id: string }): string {
  return `${offer.priceAmount ?? ''}:${offer.id}`;
}

function decodeCursor(cursor: string): { priceAmount: number | null; id: string } | undefined {
  const separator = cursor.indexOf(':');
  if (separator < 0) return undefined;
  const rawPrice = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (id === '') return undefined;
  if (rawPrice === '') return { priceAmount: null, id };
  const priceAmount = Number(rawPrice);
  if (!Number.isInteger(priceAmount)) return undefined;
  return { priceAmount, id };
}

/**
 * The comparison read: every current offer on one canonical variant, or on every
 * variant of one canonical product, cheapest first.
 *
 * One page is fetched with `limit + 1` so "is there more" is answered without a
 * second count query — the extra row is dropped and its existence IS the cursor.
 */
export async function listOffers(input: ListOffersInput): Promise<OfferPage> {
  if ((input.canonicalVariantId ? 1 : 0) + (input.canonicalProductId ? 1 : 0) !== 1) {
    throw validationError('Provide exactly one of canonicalVariantId or canonicalProductId');
  }

  const now = input.now ?? new Date();
  const db = getDb();
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (input.cursor && !after) throw validationError('Malformed cursor');

  const rows = await listOffersForComparison(db, {
    ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
    ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(input.conditionGroups ? { conditionGroups: input.conditionGroups } : {}),
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.conditions ? { conditions: input.conditions } : {}),
    excludeStale: input.includeStale !== true,
    limit: input.limit + 1,
    ...(after ? { after } : {}),
    now,
  });

  const page = rows.slice(0, input.limit);
  const context = await buildOfferProjectionContext(page, now, db);
  const projected = page.map((row) =>
    projectOffer(row.offer, row.storefrontOperatorMerchantId, context),
  );

  /**
   * #68 public behaviour 1 and 3 — the LIVE derivation has the last word.
   *
   * `stale_at` narrowed the million rows (indexed, cheap, stamped from the same
   * policy at observation time); this drops anything the source's CURRENT
   * contract refuses. The two can only disagree after a policy change, and the
   * intersection is a SUBSET of what the derivation admits — so a contractual
   * cache cap that shortens a lifetime bites at the next read with no sweep
   * having run, and the disagreement can never show an expired offer.
   *
   * The visible cost is stated rather than hidden: a page may return fewer than
   * `limit` offers, and the caller follows `nextCursor` exactly as before,
   * because the cursor is a keyset over the SQL order which this does not
   * touch.
   */
  const offers = input.includeStale === true
    ? projected
    : projected.filter((offer) => mayAppearInComparison(offer.freshness));

  const last = page[page.length - 1];
  return {
    offers,
    ...(rows.length > input.limit && last
      ? { nextCursor: encodeCursor({ priceAmount: last.offer.priceAmount, id: last.offer.id }) }
      : {}),
  };
}

/** One offer, fully projected — the operator trace's read and a deep link's. */
export async function getOffer(id: string, now: Date = new Date()): Promise<Offer | undefined> {
  const db = getDb();
  const row = await findOfferWithChannel(db, id);
  if (!row) return undefined;
  const context = await buildOfferProjectionContext([row], now, db);
  return projectOffer(row.offer, row.storefrontOperatorMerchantId, context);
}

/**
 * One external observation, as an ingestion adapter supplies it.
 *
 * `canonicalVariantId` arrives from the caller and is never resolved here: the
 * MATCHING pipeline is #58's, and a matcher living in the write path would make
 * every ingestion run able to re-point a canonical attachment as a side effect
 * of a price change. The seam is this field.
 */
export interface ExternalOfferObservation {
  kind: Exclude<OfferKind, 'native'>;
  canonicalVariantId: string;
  merchantId: string;
  storefrontId?: string;
  sourceRecordId: string;
  /**
   * The `catalog_sources` row behind that observation (#78).
   *
   * Passed rather than resolved from `sourceRecordId`, which would be one extra
   * query per ingested record on the hottest write path in the system. The
   * caller already holds it: an ingestion pass resolved the source before it
   * fetched anything.
   */
  sourceId?: string;
  /** The ingestion RUN, so #68's quarantine stays answerable when history is read (#78). */
  sourceRunId?: string;
  provider: string;
  sourceAccountRef?: string;
  externalOfferId: string;
  price?: { amount: number; currency: string };
  compareAtPrice?: { amount: number; currency: string };
  availability?: OfferAvailability;
  availableQuantity?: number;
  /**
   * The source's own condition wording, VERBATIM (#90 evidence rule 5).
   *
   * An adapter supplies what the retailer published — "Ricondizionato — Grado
   * B", "Open Box", "Gebraucht" — and never a taxonomy key. That is deliberate
   * and is the clean cut #90 makes here: an adapter deciding the key would put
   * nine independent, unversioned, unreviewable mappings in nine adapters, and
   * `condition_mapping_rulesets` exists precisely so a correction is one
   * published version rather than nine deploys.
   */
  conditionSourceLabel?: string;
  /**
   * Which provider's ruleset reads that wording.
   *
   * Absent means there is no ruleset to consult, so the offer records the label
   * and stays `unknown` — the fail-closed direction, and the one that makes the
   * first ruleset for a new source writable from what it actually says.
   */
  conditionMappingProvider?: ConditionMappingProviderId;
  sellerSku?: string;
  merchantTitle?: string;
  merchantVariantText?: string;
  destinationUrl?: string;
  affiliate?: {
    network: string;
    programRef?: string;
    publisherRef?: string;
    trackingTemplate?: string;
  };
  country?: string;
  region?: string;
  language?: string;
  delivery?: {
    cost?: { amount: number; currency: string };
    freeOver?: { amount: number; currency: string };
    minDays?: number;
    maxDays?: number;
  };
  returnPolicy?: { url?: string; windowDays?: number; policyRef?: string };
  observedAt: Date;
  /** The source's own TTL for these terms — the issue's expiry, the ADR's `stale_at`. */
  staleAt: Date;
  confidence?: number;
}

/**
 * Record one external observation, converging on its active source mapping.
 *
 * The quality signals are DERIVED from what the observation actually carried
 * rather than declared by the adapter: an adapter that forgot to flag a missing
 * price would otherwise produce an offer that reads as complete, and the whole
 * point of the signals is to tell a ranking what it does not know.
 */
export async function recordExternalOffer(
  observation: ExternalOfferObservation,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  /**
   * The clock every "seen at" and "confirmed at" stamp on the OFFER is taken
   * from — the sibling of `persistOneRecord`'s, one table over.
   *
   * `now` is the caller's clock, which for the ingestion path is the dispatcher
   * TICK's, taken before the adapter was called; `observation.observedAt` is
   * when the adapter actually read the record. For any adapter that stamps its
   * own read time — which is every real one — `observedAt` is LATER than `now`
   * by however long the fetch took, and since `firstSeenAt` is `observedAt`
   * while these two were the caller's clock, `offers_confirmed_order_check`
   * (`last_confirmed_at >= first_seen_at`) failed on the FIRST write of every
   * external offer.
   *
   * It is the same fault the object write carries the same correction for, and
   * it has to be stated in BOTH places: #68 split the page loop so the object is
   * persisted per record and the offer is materialised per PAGE, so the two
   * writes no longer share a clock. Fixing only the record half leaves this one
   * failing, which is how it was found.
   *
   * Taking the max is truthful rather than defensive: Mercaria has certainly
   * seen the offer at least as recently as it observed it. Native convergence is
   * unaffected — its `observedAt` IS its `now`, so the max is an identity.
   */
  const seenAt = observation.observedAt > now ? observation.observedAt : now;

  // #90: the taxonomy key is decided by the versioned ruleset, never by the
  // adapter. A rule below the floor produces `unknown` plus a `review_pending`
  // state, so this call is also where "a low-confidence mapping is never
  // upgraded" is produced rather than merely checked.
  const conditionColumns = observation.conditionMappingProvider
    ? await mapSourceCondition(observation.conditionMappingProvider, observation.conditionSourceLabel)
    : unmappedOfferCondition(observation.conditionSourceLabel ?? null);

  const qualitySignals: InsertOfferInput['qualitySignals'] = [];
  if (!observation.price) qualitySignals.push('missing_price');
  if (!observation.availability || observation.availability === 'unknown') {
    qualitySignals.push('missing_availability');
  }
  // Derived from what the mapping ACTUALLY produced, not from what the
  // observation carried: a label the ruleset could not resolve and a label
  // resolved below the floor are both "the wording did not map", and a ranking
  // reading this signal needs both.
  if (conditionColumns.condition === 'unknown') {
    qualitySignals.push('unmapped_condition');
  }
  if (!observation.delivery?.cost) qualitySignals.push('unknown_delivery');
  if (observation.confidence !== undefined) qualitySignals.push('heuristic_match');

  const row = await upsertExternalOffer(db, {
    kind: observation.kind,
    status: 'active',
    canonicalVariantId: observation.canonicalVariantId,
    merchantId: observation.merchantId,
    storefrontId: observation.storefrontId ?? null,
    sourceRecordId: observation.sourceRecordId,
    provider: observation.provider,
    sourceAccountRef: observation.sourceAccountRef ?? null,
    externalOfferId: observation.externalOfferId,
    priceAmount: observation.price?.amount ?? null,
    priceCurrency: observation.price?.currency ?? null,
    compareAtPriceAmount: observation.compareAtPrice?.amount ?? null,
    compareAtPriceCurrency: observation.compareAtPrice?.currency ?? null,
    availability: observation.availability ?? 'unknown',
    availableQuantity: observation.availableQuantity ?? null,
    // All five condition columns together — the shape CHECKs constrain the
    // COMBINATION, so spreading one object is what makes an impossible one
    // unassemblable here.
    ...conditionColumns,
    sellerSku: observation.sellerSku ?? null,
    merchantTitle: observation.merchantTitle ?? null,
    merchantVariantText: observation.merchantVariantText ?? null,
    destinationUrl: observation.destinationUrl ?? null,
    affiliateNetwork: observation.affiliate?.network ?? null,
    affiliateProgramRef: observation.affiliate?.programRef ?? null,
    affiliatePublisherRef: observation.affiliate?.publisherRef ?? null,
    affiliateTrackingTemplate: observation.affiliate?.trackingTemplate ?? null,
    country: observation.country ?? null,
    region: observation.region ?? null,
    language: observation.language ?? null,
    deliveryCostAmount: observation.delivery?.cost?.amount ?? null,
    deliveryCostCurrency: observation.delivery?.cost?.currency ?? null,
    deliveryFreeOverAmount: observation.delivery?.freeOver?.amount ?? null,
    deliveryFreeOverCurrency: observation.delivery?.freeOver?.currency ?? null,
    deliveryMinDays: observation.delivery?.minDays ?? null,
    deliveryMaxDays: observation.delivery?.maxDays ?? null,
    returnPolicyUrl: observation.returnPolicy?.url ?? null,
    returnPolicyWindowDays: observation.returnPolicy?.windowDays ?? null,
    returnPolicyRef: observation.returnPolicy?.policyRef ?? null,
    observedAt: observation.observedAt,
    firstSeenAt: observation.observedAt,
    lastSeenAt: seenAt,
    lastConfirmedAt: seenAt,
    staleAt: observation.staleAt,
    sourceConfidence: observation.confidence ?? null,
    qualitySignals,
  });

  /**
   * The price observation (#78), in the SAME transaction as the offer.
   *
   * An offer written with no observation behind it, or an observation with no
   * offer, is exactly the drift the price-history domain exists to prevent. A
   * failure here propagates: this runs inside the caller's transaction, so
   * catching it would leave every later statement failing with `25P02` while
   * the page reported success (`record.service.ts` states it in full), and
   * `advanceObject` already isolates a post-intake failure per record.
   *
   * The freshness level is the one the OBSERVATION was taken under, and it is
   * computed rather than resolved: an observation is zero seconds old when it
   * is taken, so the only verdict other than `current` available at that moment
   * is one the source itself declared by publishing a deadline already in the
   * past. The finer per-source WARNING fraction is a statement about age and
   * has nothing to say here.
   */
  await recordOfferPriceObservation(db, row, {
    observedAt: observation.observedAt,
    sourceRecordId: observation.sourceRecordId,
    sourceId: observation.sourceId ?? null,
    sourceRunId: observation.sourceRunId ?? null,
    freshnessLevel: observation.staleAt <= observation.observedAt ? 'expired' : 'current',
  });

  return row.id;
}

/**
 * Close out a source refresh: everything that source no longer publishes
 * retires (issue external rule 4).
 *
 * `source_disappeared`, never a DELETE — the offer row, its `source_record_id`
 * and the append-only `source_records` chain behind it survive, which is what
 * keeps the observed price history reachable after the offer stops being
 * current (acceptance 5).
 */
export async function closeSourceRefresh(
  scope: { provider: string; sourceAccountRef?: string },
  observedExternalOfferIds: readonly string[],
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  return retireOffersMissingFromSource(
    db,
    { provider: scope.provider, sourceAccountRef: scope.sourceAccountRef ?? null },
    observedExternalOfferIds,
    now,
  );
}
