/**
 * Building one reproducible merchant demand snapshot (#86
 * §MerchantDemandSnapshot).
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is an ARITHMETIC and a DISCLOSURE step over facts other domains own. It
 * reads events through `db/merchantDemand/merchantDemandFactsRepository.ts`, it
 * reads freshness through #68's OWN pure derivation, it reads save counts
 * through #80's OWN disclosure function, and it asks `seams.ts` for everything
 * nobody has built. It defines no freshness rule, no save floor and no
 * eligibility verdict of its own, and `merchant-demand-isolation.test.ts` fails
 * the build if it starts to.
 *
 * ## Every metric answers, and an answer may be "no"
 *
 * The registry is walked WHOLE. A metric with a seam produces a row saying so;
 * a metric below the floor produces a row saying so; a metric measured produces
 * a value. Skipping the unanswerable ones would make "we did not measure it"
 * indistinguishable from "this version has no such metric", and a dashboard
 * would render neither.
 *
 * ## Collection off is not zero demand
 *
 * Every metric sourced from `analytics_events` answers `collection_disabled`
 * when `ANALYTICS_COLLECTION_MODE` is `off`, which is the shipped default. That
 * is the single most important honesty property in this file: without it, the
 * first snapshot any deployment ever builds reports that nobody wanted anything
 * from anybody.
 */

import {
  MERCHANT_DEMAND_AGGREGATE_MIN_COUNT,
  MERCHANT_DEMAND_ATTRIBUTION_POLICY_VERSION,
  MERCHANT_DEMAND_EVENT_POLICY_VERSION,
  MERCHANT_DEMAND_METRICS,
  MERCHANT_DEMAND_PRODUCT_MIN_COUNT,
  MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS,
  assessOfferFreshness,
  discloseDemandCount,
  discloseProductSaveCount,
  nativeOfferFreshness,
  type MerchantDemandAggregateBasis,
  type MerchantDemandMetricDefinition,
  type CurrencyCode,
  type MerchantDemandValue,
  type OfferFreshnessLevel,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countMerchantProductImpressions,
  countMerchantScopedEvents,
  countProductScopedEvents,
  findLinkedNativeStoreId,
  findNativeOfferProductIds,
  findNewestEventInstant,
  listMerchantOfferFacts,
  readNativeOrderFacts,
  readProductSaveCounts,
  type DemandWindow,
  type MerchantOfferFact,
} from '../../db/merchantDemand/merchantDemandFactsRepository.js';
import {
  insertMerchantDemandSnapshot,
  type NewMerchantDemandMetric,
  type NewMerchantDemandProduct,
  type StoredMerchantDemandSnapshot,
} from '../../db/merchantDemand/merchantDemandSnapshotRepository.js';
import { resolveSourceFreshnessPolicies } from '../offer-freshness/policy.js';
import { requireMerchantDemandMetric } from './metrics.js';
import {
  resolveClientDiscoveryFigure,
  resolveNetworkReportedFigure,
  resolvePriceAlertDemand,
  resolveZeroResultDemand,
} from './seams.js';
import { countMerchantComparableSubjects } from '../price-signals/competitiveness.service.js';

/** What a caller asks for. */
export interface BuildMerchantDemandSnapshotInput {
  readonly merchantId: string;
  /** ISO 3166-1 alpha-2, or `''` for every market. */
  readonly market: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly now?: Date;
}

/**
 * The facts a snapshot is composed from, kept separate from the snapshot.
 *
 * Exported because the acquisition scorer reads them too, and because a scorer
 * that re-derived them from the stored rows would be a second computation that
 * could disagree with the report an operator is looking at.
 */
export interface MerchantDemandFacts {
  readonly offers: readonly MerchantOfferFact[];
  readonly canonicalProductIds: readonly string[];
  readonly nativeProductIds: ReadonlySet<string>;
  readonly offerImpressions: number;
  /**
   * Every product's views summed, for the acquisition SCORER only.
   *
   * Deliberately not what the merchant-facing metric publishes: that is
   * composed from the partition so it cannot be differenced against the rows.
   * This total is safe here because a score is a clamped mean over six inputs
   * and is not invertible, and because the operator surface serves `scoreBps`
   * rather than the terms behind it.
   */
  readonly productPageViews: number;
  readonly perProductViews: ReadonlyMap<string, number>;
  readonly perProductImpressions: ReadonlyMap<string, number>;
  readonly freshnessByOffer: ReadonlyMap<string, OfferFreshnessLevel>;
  readonly freshOfferCount: number;
  readonly saveCounts: ReadonlyMap<string, number>;
  readonly nativeStoreId: string | undefined;
  readonly nativePaidOrders: number | undefined;
  readonly nativeGrossMinor: number | undefined;
  readonly nativeCurrency: CurrencyCode | undefined;
  readonly dataFreshAsOf: Date;
  readonly collectionEnabled: boolean;
  /**
   * #82's count of subjects it could compare, and how many it examined.
   *
   * `undefined` only when the merchant offers nothing at all — the aggregation
   * is #82's and this domain neither reimplements it nor second-guesses it.
   */
  readonly comparableSubjects:
    | { readonly subjectsExamined: number; readonly subjectsComparable: number }
    | undefined;
}

/** The #68 levels that admit an offer to a comparison. Read, never redefined. */
const FRESH_LEVELS: readonly OfferFreshnessLevel[] = ['current', 'warning'];

/**
 * Gather every durable fact this snapshot needs, in one pass.
 *
 * Bounded by `config.merchantDemand.maxProductRows` on the offer read, so one
 * build is a bounded number of statements whatever the merchant's catalogue
 * size — and the snapshot's coverage counters say how many products it saw.
 */
export async function gatherMerchantDemandFacts(
  input: BuildMerchantDemandSnapshotInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantDemandFacts> {
  const now = input.now ?? new Date();
  const window: DemandWindow = {
    from: input.windowFrom,
    to: input.windowTo,
    market: input.market,
  };
  const collectionEnabled = config.analytics.collectionMode !== 'off';

  const offers = await listMerchantOfferFacts(
    {
      merchantId: input.merchantId,
      ...(input.market === '' ? {} : { market: input.market }),
      limit: config.merchantDemand.maxProductRows,
    },
    db,
  );

  const canonicalProductIds = [...new Set(offers.map((offer) => offer.canonicalProductId))];

  // #68's OWN derivation, per offer, against its OWN source's contract. This
  // domain resolves nothing about freshness: it asks, and it counts the answers.
  const policies = await resolveSourceFreshnessPolicies(
    offers.map((offer) => offer.sourceId).filter((id): id is string => id !== null),
    db,
  );
  const freshnessByOffer = new Map<string, OfferFreshnessLevel>();
  for (const offer of offers) {
    const observation = {
      sourceId: offer.sourceId,
      observedAt: offer.observedAt,
      firstSeenAt: offer.firstSeenAt,
      lastSeenAt: offer.lastSeenAt,
      lastConfirmedAt: offer.lastConfirmedAt,
      declaredUnavailableAt: offer.declaredUnavailableAt,
      storedExpiresAt: offer.staleAt,
    };
    const assessment =
      offer.kind === 'native'
        ? nativeOfferFreshness(observation, now)
        : assessOfferFreshness(
            observation,
            offer.sourceId === null ? null : (policies.get(offer.sourceId)?.policy ?? null),
            now,
          );
    freshnessByOffer.set(offer.offerId, assessment.level);
  }
  const freshOfferCount = [...freshnessByOffer.values()].filter((level) =>
    FRESH_LEVELS.includes(level),
  ).length;

  const [nativeProductIds, saveCounts, nativeStoreId] = await Promise.all([
    findNativeOfferProductIds({ merchantId: input.merchantId, canonicalProductIds }, db),
    readProductSaveCounts(canonicalProductIds, db),
    findLinkedNativeStoreId(input.merchantId, db),
  ]);

  // Event reads only happen where there are events to read. With collection off
  // the counters stay at zero AND every event-sourced metric answers
  // `collection_disabled`, so nothing downstream reads the zero as a fact.
  const perProductViews = collectionEnabled
    ? await countProductScopedEvents(
        { canonicalProductIds, eventType: 'product_page_view', window },
        db,
      )
    : new Map<string, number>();
  const perProductImpressions = collectionEnabled
    ? await countMerchantProductImpressions(
        { merchantId: input.merchantId, canonicalProductIds, window },
        db,
      )
    : new Map<string, number>();
  const offerImpressions = collectionEnabled
    ? await countMerchantScopedEvents(
        { merchantId: input.merchantId, eventType: 'offer_impression', window },
        db,
      )
    : 0;
  const newestEvent = collectionEnabled ? await findNewestEventInstant(window, db) : undefined;

  let productPageViews = 0;
  for (const views of perProductViews.values()) {
    productPageViews += views;
  }

  // #82's aggregation over the SAME bounded page of subjects this snapshot
  // reads, so the rate's denominator is the set of products the report
  // describes rather than a different one.
  const comparableSubjects =
    offers.length === 0
      ? undefined
      : await countMerchantComparableSubjects({
          merchantId: input.merchantId,
          limit: config.merchantDemand.maxProductRows,
          ...(input.market === '' ? {} : { market: input.market }),
          now,
        });

  const nativeOrders =
    nativeStoreId === undefined
      ? undefined
      : await readNativeOrderFacts({ storeId: nativeStoreId, window }, db);

  return {
    offers,
    canonicalProductIds,
    nativeProductIds,
    offerImpressions,
    productPageViews,
    perProductViews,
    perProductImpressions,
    freshnessByOffer,
    freshOfferCount,
    saveCounts,
    nativeStoreId,
    nativePaidOrders: nativeOrders?.paidOrderCount,
    nativeGrossMinor: nativeOrders?.grossAmountMinor,
    nativeCurrency: nativeOrders?.currency,
    // The freshest thing the snapshot could actually see. Bounded by the window
    // so a report never claims to be fresher than the period it describes.
    dataFreshAsOf: newestEvent ?? input.windowTo,
    collectionEnabled,
    comparableSubjects,
  };
}

/**
 * The ONE partition every product-composed figure is built from.
 *
 * This is the fix for a differencing attack that survived four other defences:
 * the aggregate and the product breakdown sum over the SAME population at
 * DIFFERENT grains, so publishing an exact total beside the rows above a floor
 * hands the merchant every withheld row by subtraction. Computing the partition
 * ONCE and composing both from it is what makes the two consistent by
 * construction rather than by two functions agreeing.
 */
interface ProductPartition {
  readonly rows: readonly NewMerchantDemandProduct[];
  /** The products the floor withheld. Their VALUES never leave this module. */
  readonly suppressedProductIds: readonly string[];
}

/** Split the merchant's products into the disclosed rows and the withheld ones. */
function partitionProducts(facts: MerchantDemandFacts): ProductPartition {
  const rows: NewMerchantDemandProduct[] = [];
  const suppressedProductIds: string[] = [];

  // The freshest level any of the merchant's offers has on each product. A
  // product with one expired and one current offer is sellable, so reporting
  // the worst would tell a merchant to fix something that is working.
  const bestByProduct = new Map<string, OfferFreshnessLevel>();
  const rank: Record<OfferFreshnessLevel, number> = {
    current: 0,
    warning: 1,
    unknown: 2,
    expired: 3,
    unavailable: 4,
  };
  for (const offer of facts.offers) {
    const level = facts.freshnessByOffer.get(offer.offerId) ?? 'unknown';
    const existing = bestByProduct.get(offer.canonicalProductId);
    if (existing === undefined || rank[level] < rank[existing]) {
      bestByProduct.set(offer.canonicalProductId, level);
    }
  }

  for (const productId of facts.canonicalProductIds) {
    const views = facts.perProductViews.get(productId) ?? 0;
    const impressions = facts.perProductImpressions.get(productId) ?? 0;
    // The floor is applied to the LARGER of the two counts, not to each
    // independently: suppressing per field publishes the one that cleared it
    // and bounds the one that did not, which is the differencing attack the
    // floor exists to stop (#77's merchant summary makes the same choice).
    if (Math.max(views, impressions) < MERCHANT_DEMAND_PRODUCT_MIN_COUNT) {
      suppressedProductIds.push(productId);
      continue;
    }
    rows.push({
      canonicalProductId: productId,
      productPageViews: views,
      offerImpressions: impressions,
      hasNativeOffer: facts.nativeProductIds.has(productId),
      offerFreshness: bestByProduct.get(productId) ?? 'unknown',
    });
  }

  return { rows, suppressedProductIds };
}

/** A metric's answer, plus the population a composed one covers. */
interface MetricAnswer {
  readonly value: MerchantDemandValue;
  readonly basis?: MerchantDemandAggregateBasis;
}

/**
 * Compose one product-derived aggregate from the partition.
 *
 * The disclosed rows are published exactly — they are already visible. The
 * withheld ones become at most ONE residual, and it is published only when both
 * floors clear: the value floor bounds how large a published residual is, and
 * the CONTRIBUTOR floor bounds how few things it could be about. The second is
 * the one that matters here — a residual over a single withheld product IS that
 * product's count, whatever its size.
 *
 * When the residual is folded away the figure is the disclosed rows, and the
 * BASIS says so. Suppressing the aggregate instead was the other option and is
 * worse: a long tail puts something below the floor almost always, so the
 * metric would be permanently withheld and the dashboard would carry a
 * column nobody can read.
 */
function composeFromPartition(
  input: {
    readonly perProduct: ReadonlyMap<string, number>;
    readonly partition: ProductPartition;
    readonly include?: (productId: string) => boolean;
    readonly floor: number;
  },
): MetricAnswer {
  const admits = input.include ?? ((): boolean => true);
  let disclosed = 0;
  for (const row of input.partition.rows) {
    if (!admits(row.canonicalProductId)) continue;
    disclosed += input.perProduct.get(row.canonicalProductId) ?? 0;
  }

  let residual = 0;
  let contributors = 0;
  for (const productId of input.partition.suppressedProductIds) {
    if (!admits(productId)) continue;
    const value = input.perProduct.get(productId) ?? 0;
    if (value <= 0) continue;
    residual += value;
    contributors += 1;
  }

  const publishResidual =
    contributors >= MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS && residual >= input.floor;
  const basis: MerchantDemandAggregateBasis = publishResidual
    ? 'whole_catalogue'
    : 'disclosed_rows_only';
  const total = publishResidual ? disclosed + residual : disclosed;
  const value = discloseDemandCount(total, input.floor);
  // A basis describes a FIGURE. A suppressed one has none to describe.
  return value.state === 'measured' ? { value, basis } : { value };
}

/**
 * Turn one metric definition into a value, given the facts.
 *
 * A `switch` over the registry rather than a table of functions, so adding a
 * metric key without deciding how it is computed fails `tsc`'s exhaustiveness
 * on the default branch — which throws, rather than quietly answering zero.
 */
function valueFor(
  definition: MerchantDemandMetricDefinition,
  facts: MerchantDemandFacts,
  partition: ProductPartition,
): MetricAnswer {
  // An event-sourced metric on a deployment that collects nothing has no
  // number, and the reason is this deployment's own configuration rather than
  // somebody else's unbuilt issue.
  if (definition.source === 'analytics_events' && !facts.collectionEnabled) {
    return { value: { state: 'unavailable', reason: 'collection_disabled' } };
  }

  const floor = MERCHANT_DEMAND_AGGREGATE_MIN_COUNT;

  switch (definition.key) {
    case 'search_result_impressions':
    case 'native_add_to_cart':
    case 'native_checkout_starts':
      return { value: resolveClientDiscoveryFigure() };
    case 'human_outbound_clicks':
    case 'unavailable_click_rate':
    case 'network_reported_conversions':
    case 'affiliate_commission':
    case 'external_order_value':
      return { value: resolveNetworkReportedFigure() };
    case 'price_alert_demand':
      return { value: resolvePriceAlertDemand() };
    case 'zero_result_demand':
      return { value: resolveZeroResultDemand() };

    // The three product-composed figures. Each is the disclosed rows plus at
    // most one residual over the withheld ones — never a total taken over the
    // whole map beside a breakdown that omits part of it.
    case 'product_page_views_with_offer':
      return composeFromPartition({ perProduct: facts.perProductViews, partition, floor });
    case 'offer_impressions':
      return composeFromPartition({ perProduct: facts.perProductImpressions, partition, floor });
    case 'native_offer_views':
      // A merchant with no native store has not activated, and a native view
      // count of zero would read as "nobody looked" rather than "there is
      // nothing here to look at".
      if (facts.nativeProductIds.size === 0) {
        return { value: { state: 'unavailable', reason: 'no_native_activation' } };
      }
      return composeFromPartition({
        perProduct: facts.perProductViews,
        partition,
        include: (productId) => facts.nativeProductIds.has(productId),
        floor,
      });

    case 'native_paid_orders':
      if (facts.nativePaidOrders === undefined) {
        return { value: { state: 'unavailable', reason: 'no_native_activation' } };
      }
      return { value: discloseDemandCount(facts.nativePaidOrders, floor) };
    case 'native_gmv': {
      if (facts.nativeGrossMinor === undefined || facts.nativeCurrency === undefined) {
        return { value: { state: 'unavailable', reason: 'no_native_activation' } };
      }
      // The floor applies to the ORDER COUNT, never to the amount: suppressing
      // on the money would disclose that the amount was small, and a merchant
      // with three large orders is exactly as identifiable as one with three
      // small ones.
      if ((facts.nativePaidOrders ?? 0) < floor) return { value: { state: 'suppressed', floor } };
      return {
        value: {
          state: 'measured',
          measure: {
            unit: 'money',
            amount: facts.nativeGrossMinor,
            // The store's own accounting currency, read off the store row.
            currency: facts.nativeCurrency,
          },
        },
      };
    }

    case 'product_save_demand': {
      let total = 0;
      // #80's OWN disclosure function, per product, before anything is summed.
      // Summing first and flooring the total would publish a sum over products
      // #80 withholds individually.
      for (const productId of facts.canonicalProductIds) {
        const disclosure = discloseProductSaveCount(facts.saveCounts.get(productId) ?? 0);
        if (disclosure.disclosed) total += disclosure.count;
      }
      return { value: discloseDemandCount(total, floor) };
    }

    case 'demand_without_native_offer': {
      let count = 0;
      for (const productId of facts.canonicalProductIds) {
        if (facts.nativeProductIds.has(productId)) continue;
        const views = facts.perProductViews.get(productId) ?? 0;
        if (views >= MERCHANT_DEMAND_PRODUCT_MIN_COUNT) count += 1;
      }
      return { value: discloseDemandCount(count, floor) };
    }

    case 'subjects_with_a_price_comparison': {
      // #82's OWN aggregation, gathered with the rest of the facts. A merchant
      // with no subjects examined has no rate — a 0/0 rendered as 0% is the
      // "nobody wanted your products" failure wearing a percentage sign.
      if (facts.comparableSubjects === undefined) {
        return { value: { state: 'unavailable', reason: 'relationship_not_defensible' } };
      }
      if (facts.comparableSubjects.subjectsExamined === 0) {
        return { value: { state: 'unavailable', reason: 'relationship_not_defensible' } };
      }
      return {
        value: {
          state: 'measured',
          measure: {
            unit: 'rate',
            numerator: facts.comparableSubjects.subjectsComparable,
            denominator: facts.comparableSubjects.subjectsExamined,
          },
        },
      };
    }

    case 'catalog_freshness_rate': {
      const denominator = facts.offers.length;
      if (denominator === 0) {
        return { value: { state: 'unavailable', reason: 'relationship_not_defensible' } };
      }
      return {
        value: {
          state: 'measured',
          measure: { unit: 'rate', numerator: facts.freshOfferCount, denominator },
        },
      };
    }

    default:
      // A key with no branch is a metric somebody added to the registry without
      // deciding how it is computed. Answering zero would ship it; throwing
      // fails the first build that touches it.
      throw new Error(`merchant demand metric '${definition.key}' has no computation`);
  }
}

/** The stored-row shape for one value. */
function toMetricRow(
  definition: MerchantDemandMetricDefinition,
  answer: MetricAnswer,
): NewMerchantDemandMetric {
  const value = answer.value;
  const base = {
    metricKey: definition.key,
    kind: definition.kind,
    // Sliced by nothing today. The columns exist and the CHECK admits a slice,
    // so #86 snapshot items 6 and 7 are a WRITE away rather than a migration —
    // the undimensioned bucket is the `analytics_rollups` `''` convention.
    channel: '',
    storefrontId: '',
    sourceId: '',
    ...(answer.basis === undefined ? {} : { aggregateBasis: answer.basis }),
  } as const;

  if (value.state === 'suppressed') return { ...base, suppressedBelow: value.floor };
  if (value.state === 'unavailable') {
    return {
      ...base,
      unavailableReason: value.reason,
      ...(value.seam === undefined ? {} : { unavailableSeam: value.seam }),
    };
  }
  if (value.measure.unit === 'count') return { ...base, countValue: value.measure.count };
  if (value.measure.unit === 'money') {
    return {
      ...base,
      amountValue: value.measure.amount,
      amountCurrency: value.measure.currency,
    };
  }
  return {
    ...base,
    rateNumerator: value.measure.numerator,
    rateDenominator: value.measure.denominator,
  };
}

/**
 * Build and PERSIST one snapshot, superseding whichever it replaces.
 *
 * The whole registry is walked, so the stored row set is complete and a reader
 * can tell an unmeasurable metric from an absent one.
 */
export async function buildMerchantDemandSnapshot(
  input: BuildMerchantDemandSnapshotInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoredMerchantDemandSnapshot> {
  const now = input.now ?? new Date();
  const facts = await gatherMerchantDemandFacts({ ...input, now }, db);

  // ONE partition, then both consumers. The order is the guarantee: an
  // aggregate cannot be composed over a population the rows were not drawn
  // from, because there is only one drawing of it.
  const partition = partitionProducts(facts);
  const metrics = MERCHANT_DEMAND_METRICS.map((definition) =>
    toMetricRow(definition, valueFor(definition, facts, partition)),
  );

  return insertMerchantDemandSnapshot(
    {
      header: {
        merchantId: input.merchantId,
        market: input.market,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        dataFreshAsOf: facts.dataFreshAsOf,
        eventPolicyVersion: MERCHANT_DEMAND_EVENT_POLICY_VERSION,
        attributionPolicyVersion: MERCHANT_DEMAND_ATTRIBUTION_POLICY_VERSION,
        collectionMode: config.analytics.collectionMode,
        aggregateFloor: MERCHANT_DEMAND_AGGREGATE_MIN_COUNT,
        productFloor: MERCHANT_DEMAND_PRODUCT_MIN_COUNT,
        productsOffered: facts.canonicalProductIds.length,
        productRowsDisclosed: partition.rows.length,
        productRowsSuppressed: partition.suppressedProductIds.length,
        expiresAt: new Date(
          now.getTime() + config.merchantDemand.snapshotRetentionDays * 24 * 60 * 60 * 1_000,
        ),
      },
      metrics,
      products: partition.rows,
    },
    db,
  );
}

/** The registry-driven value for one metric, over the same partition a snapshot uses. */
export function merchantDemandValueFor(
  metricKey: string,
  facts: MerchantDemandFacts,
): MerchantDemandValue {
  return valueFor(requireMerchantDemandMetric(metricKey), facts, partitionProducts(facts)).value;
}
