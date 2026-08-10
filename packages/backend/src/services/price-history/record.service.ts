/**
 * The write chokepoint — one function, called from the two places an offer's
 * terms are observed (#78 §"Snapshot policy").
 *
 * ## Only an OBSERVATION writes an observation
 *
 * `recordOfferPriceObservation` is called after an external upsert and after a
 * native convergence, and by nothing else. A RETIREMENT — whether it comes from
 * a source's explicit removal, from a snapshot omission or from the expiry
 * sweep — writes nothing here, and that is issue snapshot policy 5: "a source
 * outage does not create a false unavailable or zero-price point". A retirement
 * would put a point on a chart at the last known price on a day nobody could
 * buy the thing, which is the most misleading shape a price chart can take.
 * What a retirement produces instead is a GAP, and a gap is a true statement
 * about what Mercaria knows.
 *
 * ## An offer with no price produces nothing at all
 *
 * `offer_price_snapshots.item_price_amount` is NOT NULL, so a priceless
 * observation has no row shape to be misread as zero later. The refusal is
 * COUNTED (`refused`), because a source that silently stopped publishing prices
 * would otherwise look identical to a source nobody is ingesting.
 *
 * ## It commits with the offer
 *
 * The call takes the caller's transaction handle. An observation recorded
 * without its offer, or an offer written with no observation, is exactly the
 * drift this domain exists to prevent — and #62's ingest loop already isolates
 * a per-record failure, so a refused observation costs one record rather than a
 * page.
 *
 * ## There is deliberately no `try`/`catch` around this write, anywhere
 *
 * The obvious defensive shape — swallow a malformed observation so it cannot
 * take a page of offers down with it — is not merely unnecessary here, it is
 * actively wrong: this write runs inside the CALLER's transaction, and in
 * PostgreSQL one failed statement aborts the WHOLE transaction. Catching the
 * rejection in JavaScript does not un-fail it, so every later statement fails
 * with `25P02` and the symptom is a page that reports success while having
 * committed nothing. So a failure propagates, which is where the isolation
 * already is: #62's page loop records a per-record `record_error` and
 * continues, and the native converger's own transaction rolls back and is
 * retried by its outbox. The refusals that ARE expected — an offer with no
 * price — are not exceptions at all; they are counted outcomes.
 */

import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  PRICE_HISTORY_POLICY_VERSION,
  type OfferFreshnessLevel,
  type PriceSeriesGranularity,
  type PriceTaxInclusion,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  findLatestPriceSnapshot,
  insertPriceSnapshot,
} from '../../db/priceHistory/priceSnapshotRepository.js';
import {
  priceMetricsBucketDay,
  recordPriceWriteOutcome,
} from '../../db/priceHistory/priceWriteMetricsRepository.js';
import { requestPriceSeriesRebuild } from '../../db/priceHistory/priceSeriesRepository.js';
import { findActiveSourcePolicy } from '../../db/ingestion/catalogSourcePolicyRepository.js';
import { findCanonicalVariantById } from '../../db/canonical/canonicalVariantRepository.js';
import { narrowStoredCondition } from '../condition/condition-projection.js';
import type { OfferRow } from '../../db/offers/offerRepository.js';
import {
  decideObservationWrite,
  detectObservationAnomalies,
  observationHash,
  type ObservedTerms,
} from './observation.js';

/** What the caller knows about the observation that produced this offer state. */
export interface OfferPriceObservationContext {
  /** When the source was READ. Never the writer's clock for an external offer. */
  readonly observedAt: Date;
  /** The provenance record, when there is one. Native offers have none. */
  readonly sourceRecordId?: string | null;
  readonly sourceId?: string | null;
  /** The ingestion run, so a quarantine stays answerable at read time. */
  readonly sourceRunId?: string | null;
  /** #68's verdict at the moment of observation — a record, not a live read. */
  readonly freshnessLevel: OfferFreshnessLevel;
  /**
   * The observation this one CORRECTS.
   *
   * A correction is a NEW record naming the one it revises (issue snapshot
   * policy 7); nothing in this domain can mutate the record being corrected,
   * because the table's trigger refuses an UPDATE outright.
   */
  readonly supersedesSnapshotId?: string | null;
  readonly taxInclusion?: PriceTaxInclusion;
}

/** What the write did, so a caller can log or count it without re-reading. */
export type OfferPriceObservationOutcome =
  | { readonly outcome: 'written'; readonly snapshotId: string; readonly anomalous: boolean }
  | { readonly outcome: 'deduplicated' }
  | { readonly outcome: 'refused'; readonly reason: 'no_price' };

/**
 * The granularities a deployment keeps series in.
 *
 * `day` is the detail and `week` is issue operations 8's rollup BY AGE — a
 * coarser series over the SAME observations, produced by the same derivation
 * with a different bucketing function, so a rollup can never disagree with the
 * detail it summarises. `month` exists in the vocabulary and is not enqueued by
 * a write: a monthly chart of a catalogue nobody has looked at for a year is
 * work no observation should pay for, and an operator can request one.
 */
const ENQUEUED_GRANULARITIES: readonly PriceSeriesGranularity[] = ['day', 'week'];

/**
 * Record one observation of one offer's terms.
 *
 * @returns what happened, already counted in `offer_price_write_metrics`.
 */
export async function recordOfferPriceObservation(
  db: DatabaseOrTransaction,
  offer: OfferRow,
  context: OfferPriceObservationContext,
): Promise<OfferPriceObservationOutcome> {
  const day = priceMetricsBucketDay(context.observedAt);
  const sourceId = context.sourceId ?? null;

  if (offer.priceAmount === null || offer.priceCurrency === null) {
    await recordPriceWriteOutcome({ day, sourceId, refused: 1 }, db);
    return { outcome: 'refused', reason: 'no_price' };
  }

  const terms: ObservedTerms = {
    itemPriceAmount: offer.priceAmount,
    itemPriceCurrency: offer.priceCurrency,
    compareAtPriceAmount: offer.compareAtPriceAmount,
    compareAtPriceCurrency: offer.compareAtPriceCurrency,
    shippingCostAmount: offer.deliveryCostAmount,
    shippingCostCurrency: offer.deliveryCostCurrency,
    taxInclusion: context.taxInclusion ?? 'unknown',
    // The stored column still carries the transitional `'used'` until migration
    // `0031` narrows its CHECK; `narrowStoredCondition` is #90's own one-place
    // fix and both disappear together. `unknown` is passed through rather than
    // narrowed — it is a real member of the OFFER vocabulary and not of the
    // taxonomy, and the derivation is what refuses it entry to a series.
    conditionKey: offer.condition === 'unknown' ? 'unknown' : narrowStoredCondition(offer.condition),
    availability: offer.availability,
  };

  const latest = await findLatestPriceSnapshot(offer.id, db);
  const previousTerms: ObservedTerms | undefined = latest
    ? {
        itemPriceAmount: latest.itemPriceAmount,
        itemPriceCurrency: latest.itemPriceCurrency,
        compareAtPriceAmount: latest.compareAtPriceAmount,
        compareAtPriceCurrency: latest.compareAtPriceCurrency,
        shippingCostAmount: latest.shippingCostAmount,
        shippingCostCurrency: latest.shippingCostCurrency,
        taxInclusion: latest.taxInclusion,
        conditionKey: latest.conditionKey,
        availability: latest.availability,
      }
    : undefined;

  const decision = decideObservationWrite({
    terms,
    previous: latest && previousTerms ? { terms: previousTerms, observedAt: latest.observedAt } : undefined,
    observedAt: context.observedAt,
    anchorIntervalMs: config.priceHistory.anchorIntervalSeconds * 1_000,
  });

  if (!decision.write) {
    await recordPriceWriteOutcome({ day, sourceId, deduplicated: 1 }, db);
    return { outcome: 'deduplicated' };
  }

  const anomalies = detectObservationAnomalies(terms, previousTerms);
  // A correction names the record it revises, and its reason set says so
  // rather than describing the fields that moved: an operator reading the
  // trail needs to know that a human or a source revised an earlier reading,
  // which is a different fact from the price having changed.
  const changeReasons = context.supersedesSnapshotId ? (['correction'] as const) : decision.changeReasons;

  const snapshot = await insertPriceSnapshot(
    {
      offerId: offer.id,
      sourceRecordId: context.sourceRecordId ?? null,
      sourceRunId: context.sourceRunId ?? null,
      sourceId,
      observedAt: context.observedAt,
      itemPriceAmount: terms.itemPriceAmount,
      itemPriceCurrency: terms.itemPriceCurrency,
      compareAtPriceAmount: terms.compareAtPriceAmount,
      compareAtPriceCurrency: terms.compareAtPriceCurrency,
      shippingCostAmount: terms.shippingCostAmount,
      shippingCostCurrency: terms.shippingCostCurrency,
      taxInclusion: terms.taxInclusion,
      conditionKey: terms.conditionKey,
      availability: terms.availability,
      market: offer.country,
      region: offer.region,
      language: offer.language,
      freshnessLevel: context.freshnessLevel,
      observationHash: observationHash(terms),
      changeReasons: [...changeReasons],
      anomalies,
      supersedesSnapshotId: context.supersedesSnapshotId ?? null,
      retentionExpiresAt: await resolveRetentionDeadline(db, sourceId, context.observedAt),
    },
    db,
  );

  await recordPriceWriteOutcome(
    { day, sourceId, written: 1, flaggedAnomalous: anomalies.length > 0 ? 1 : 0 },
    db,
  );
  await enqueueSeriesForOffer(db, offer, context.observedAt);

  return { outcome: 'written', snapshotId: snapshot.id, anomalous: anomalies.length > 0 };
}

/**
 * The source's own retention deadline for this observation (issue snapshot
 * policy 8, operations 6).
 *
 * From `catalog_source_policies.cache_ttl_seconds`, which is the contractual
 * cache cap #62 already models and #68 already applies as a display bound. NULL
 * — no deadline — for a native offer, for a source with no active policy, and
 * for a source whose policy grants unbounded caching, which is the ordinary
 * case and the one the sweep never touches.
 *
 * Stamped from the policy ACTIVE at write time and never recomputed, so a later
 * policy change cannot retroactively shorten what was already lawfully kept and
 * cannot silently lengthen it either.
 */
async function resolveRetentionDeadline(
  db: DatabaseOrTransaction,
  sourceId: string | null,
  observedAt: Date,
): Promise<Date | null> {
  if (!sourceId) return null;
  const policy = await findActiveSourcePolicy(db, sourceId);
  if (!policy || !policy.mayCache || policy.cacheTtlSeconds === null) return null;
  return new Date(observedAt.getTime() + policy.cacheTtlSeconds * 1_000);
}

/**
 * Ask for every series this observation could change to be rebuilt.
 *
 * The variant is the offer's own; the product is one join away and is read
 * rather than copied onto the observation, for the reason the schema docblock
 * states. Enqueued per configured display currency and per rollup granularity —
 * with `PRICE_HISTORY_SERIES_CURRENCIES` empty, which is the default, NOTHING
 * is enqueued and the domain records observations while building no charts at
 * all. That is the rollout position: the durable record is never gated, and the
 * derived answer is.
 */
async function enqueueSeriesForOffer(
  db: DatabaseOrTransaction,
  offer: OfferRow,
  now: Date,
): Promise<void> {
  const currencies = config.priceHistory.seriesCurrencies;
  if (currencies.length === 0) return;

  const variant = await findCanonicalVariantById(db, offer.canonicalVariantId);

  for (const displayCurrency of currencies) {
    for (const granularity of ENQUEUED_GRANULARITIES) {
      await requestPriceSeriesRebuild(
        {
          scopeKind: 'canonical_variant',
          canonicalVariantId: offer.canonicalVariantId,
          displayCurrency,
          granularity,
        },
        PRICE_HISTORY_POLICY_VERSION,
        db,
        now,
      );
      if (variant?.productId) {
        await requestPriceSeriesRebuild(
          {
            scopeKind: 'canonical_product',
            canonicalProductId: variant.productId,
            displayCurrency,
            granularity,
          },
          PRICE_HISTORY_POLICY_VERSION,
          db,
          now,
        );
      }
    }
  }
}

