/**
 * The public read (#78 §"API and UI").
 *
 * Everything a chart needs to be honest is composed HERE rather than on three
 * clients: the gap ranges, the ranges nothing has been built for yet, the
 * textual summary, the data table and the standing notice that a converted
 * figure is not a way to pay. A summary composed on three clients is three
 * summaries, and the one that gets a gap wrong is the one nobody is looking at.
 */

import {
  ALL_CURRENCY_CODES,
  CURRENCY_PRECISION,
  PRICE_HISTORY_DISPLAY_NOTICE,
  PRICE_HISTORY_POLICY_VERSION,
  PRICE_MEASURE_INCLUDES_DELIVERY,
  mayAppearInComparison,
  nativeOfferFreshness,
  assessOfferFreshness,
  priceHistoryBucketEnd,
  priceHistoryBuckets,
  type ConditionGroup,
  type CurrencyCode,
  type FxRates,
  type Money,
  type PriceHistoryGap,
  type PriceHistoryPoint,
  type PriceHistoryQuery,
  type PriceHistoryResponse,
  type PriceHistorySummary,
  type PriceHistoryTableRow,
  type PriceHistoryUncovered,
  type PriceHistoryValue,
  type PriceSeriesMeasure,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findOfferById } from '../../db/offers/offerRepository.js';
import {
  findPriceSeries,
  listPricePoints,
  requestPriceSeriesRebuild,
  type OfferPricePointRow,
} from '../../db/priceHistory/priceSeriesRepository.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { eq } from 'drizzle-orm';
import { convert, getRates, pairRate } from '../fx.service.js';
import { resolveSourceFreshnessPolicy } from '../offer-freshness/policy.js';
import { derivePointsForScope, rebuildWindow } from './rebuild.service.js';
import type { DerivedPricePoint } from './derive.js';

/** Everything a point needs, whether it came from a row or from a live derivation. */
interface ReadablePoint {
  readonly bucketStart: Date;
  readonly measure: PriceSeriesMeasure;
  readonly segment: ConditionGroup;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly observedAt: Date;
  readonly admittedFreshness: 'current' | 'warning';
  readonly contributingObservationCount: number;
  readonly native: Money;
  readonly displayAmount: number;
  readonly displayCurrency: CurrencyCode;
  readonly fx?: {
    readonly rate: number;
    readonly from: CurrencyCode;
    readonly to: CurrencyCode;
    readonly provider: string;
    readonly asOf: Date;
  };
}

function fromRow(row: OfferPricePointRow, displayCurrency: CurrencyCode): ReadablePoint {
  return {
    bucketStart: row.bucketStart,
    measure: row.measure,
    segment: row.segment,
    offerId: row.offerId,
    snapshotId: row.snapshotId,
    observedAt: row.observedAt,
    admittedFreshness: row.admittedFreshness,
    contributingObservationCount: row.contributingObservationCount,
    native: { amount: row.nativeAmount, currency: row.nativeCurrency },
    displayAmount: row.displayAmount,
    displayCurrency,
    ...(row.fxRate !== null && row.fxFrom !== null && row.fxTo !== null && row.fxProvider !== null && row.fxAsOf !== null
      ? {
          fx: {
            rate: row.fxRate,
            from: row.fxFrom as CurrencyCode,
            to: row.fxTo as CurrencyCode,
            provider: row.fxProvider,
            asOf: row.fxAsOf,
          },
        }
      : {}),
  };
}

function fromDerived(point: DerivedPricePoint, displayCurrency: CurrencyCode): ReadablePoint {
  return { ...point, displayCurrency };
}

/**
 * Render one point in the currency the caller asked for (#78 currency rules 3,
 * 4 and 5).
 *
 * Three outcomes and one refusal, and the refusal is what makes rule 5 real:
 * with `allowCurrentRateReinterpretation` off — the default — a point built in
 * a currency the caller did not ask for is simply not returned, and the range
 * it sat in reads as uncovered rather than as a number with a footnote nobody
 * reads.
 */
function valueFor(
  point: ReadablePoint,
  requested: CurrencyCode,
  rates: FxRates,
  allowReinterpretation: boolean,
): PriceHistoryValue | undefined {
  const native = { amount: point.native.amount, currency: point.native.currency };

  // Nothing was converted: the source published in exactly this currency.
  if (point.native.currency === requested) {
    return { basis: 'source_native', money: { ...point.native }, native };
  }

  // The point's own stored quote answers the question.
  if (point.displayCurrency === requested) {
    const fx = point.fx;
    if (!fx) {
      // A point whose display currency differs from its native currency ALWAYS
      // carries a quote — the FX shape CHECK makes the alternative
      // unrepresentable — so this branch is reachable only from a derivation
      // bug. Returning nothing is the fail-closed direction: a converted figure
      // with no identifiable rate is the one thing currency rule 4 forbids.
      return undefined;
    }
    return {
      basis: 'historical_quote',
      money: { amount: point.displayAmount, currency: requested },
      native,
      quote: {
        from: fx.from,
        to: fx.to,
        rate: fx.rate,
        provider: fx.provider,
        asOf: fx.asOf.toISOString(),
      },
    };
  }

  if (!allowReinterpretation) return undefined;

  const nativeCurrency = point.native.currency as CurrencyCode;
  if (!ALL_CURRENCY_CODES.includes(nativeCurrency)) return undefined;
  const currentRate = safePairRate(nativeCurrency, requested, rates);
  if (currentRate === undefined) return undefined;
  const money = safeConvert({ amount: point.native.amount, currency: nativeCurrency }, requested, rates);
  if (!money) return undefined;

  return {
    basis: 'current_rate_reinterpretation',
    money,
    native,
    quote: {
      from: nativeCurrency,
      to: requested,
      rate: currentRate,
      provider: rates.provider,
      asOf: rates.asOf,
    },
    // The rate the point was BUILT under, which the one above reinterprets. A
    // point with no stored quote was never converted, so its historical rate is
    // the identity — stated rather than omitted, because "there was no
    // conversion" and "we do not know what the conversion was" are different
    // facts and only one of them is reproducible.
    historicalQuote: point.fx
      ? {
          from: point.fx.from,
          to: point.fx.to,
          rate: point.fx.rate,
          provider: point.fx.provider,
          asOf: point.fx.asOf.toISOString(),
        }
      : {
          from: nativeCurrency,
          to: nativeCurrency,
          rate: 1,
          provider: 'identity',
          asOf: point.observedAt.toISOString(),
        },
  };
}

/** `pairRate` THROWS on a pair the map cannot serve; a chart must not. */
function safePairRate(from: CurrencyCode, to: CurrencyCode, rates: FxRates): number | undefined {
  try {
    return pairRate(from, to, rates);
  } catch {
    // Deliberately swallowed and answered as ABSENCE: the caller's next line
    // omits the point, which is the honest outcome for "no rate could be
    // resolved". It is not silent — the point's absence shows up as a gap the
    // response reports.
    return undefined;
  }
}

function safeConvert(money: Money, to: CurrencyCode, rates: FxRates): Money | undefined {
  try {
    return convert(money, to, rates);
  } catch {
    return undefined;
  }
}

/**
 * Answer one price-history query.
 *
 * A merchant- or storefront-filtered query DERIVES live from the same function
 * the rebuild uses; everything else reads the stored series. The split is
 * stated in `PriceHistoryQuery`: materialising every seller's own series is a
 * combinatorial explosion, and one seller's history on one product is small
 * enough not to need it.
 */
export async function readPriceHistory(
  query: PriceHistoryQuery,
  now: Date = new Date(),
): Promise<PriceHistoryResponse> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  const displayCurrency = query.scope.displayCurrency;
  const filtered = Boolean(query.merchantId || query.storefrontId);

  const rates = await getRates(displayCurrency, [...ALL_CURRENCY_CODES]);

  let points: ReadablePoint[];
  let coveredFrom: Date | undefined;
  let coveredThrough: Date | undefined;
  let rebuiltAt: Date | undefined;

  if (filtered) {
    const derived = await derivePointsForScope(
      {
        canonicalProductId: query.scope.canonicalProductId,
        canonicalVariantId: query.scope.canonicalVariantId,
        market: query.scope.market,
        merchantId: query.merchantId,
        storefrontId: query.storefrontId,
        displayCurrency,
        granularity: query.scope.granularity,
      },
      { from, to },
      now,
    );
    points = derived.points
      .filter((point) => point.measure === query.measure && point.segment === query.segment)
      .map((point) => fromDerived(point, displayCurrency));
    // A live derivation examined exactly the window it was asked for, so its
    // coverage IS the request. There is no "not yet built" range for it.
    coveredFrom = from;
    coveredThrough = to;
  } else {
    const series = await findPriceSeries({
      scopeKind: query.scope.kind,
      canonicalProductId: query.scope.canonicalProductId ?? null,
      canonicalVariantId: query.scope.canonicalVariantId ?? null,
      market: query.scope.market ?? null,
      displayCurrency,
      granularity: query.scope.granularity,
    });

    if (!series) {
      // Ensure the question exists so the loop can answer it, and report
      // honestly that nothing has been built. Creating the series is a write on
      // a GET, which is deliberate and bounded: the series set is a function of
      // the catalogue and the configured currencies, not of traffic, and the
      // alternative is a chart that stays empty until somebody happens to
      // observe an offer.
      await requestPriceSeriesRebuild(
        {
          scopeKind: query.scope.kind,
          canonicalProductId: query.scope.canonicalProductId ?? null,
          canonicalVariantId: query.scope.canonicalVariantId ?? null,
          market: query.scope.market ?? null,
          displayCurrency,
          granularity: query.scope.granularity,
        },
        PRICE_HISTORY_POLICY_VERSION,
        getDb(),
        now,
      );
      points = [];
    } else {
      const rows = await listPricePoints({
        seriesId: series.id,
        measure: query.measure,
        segment: query.segment,
        from,
        to,
      });
      points = rows.map((row) => fromRow(row, series.displayCurrency));
      coveredFrom = series.coveredFrom ?? undefined;
      coveredThrough = series.coveredThrough ?? undefined;
      rebuiltAt = series.rebuiltAt ?? undefined;
    }
  }

  const rendered: PriceHistoryPoint[] = [];
  for (const point of points) {
    const value = valueFor(
      point,
      displayCurrency,
      rates,
      query.allowCurrentRateReinterpretation === true,
    );
    if (!value) continue;
    rendered.push({
      bucketStart: point.bucketStart.toISOString(),
      measure: point.measure,
      segment: point.segment,
      value,
      offerId: point.offerId,
      observationId: point.snapshotId,
      observedAt: point.observedAt.toISOString(),
      eligibility: {
        admittedFreshness: point.admittedFreshness,
        measure: point.measure,
        segment: point.segment,
      },
      contributingObservationCount: point.contributingObservationCount,
    });
  }

  const { gaps, uncovered, table } = describeCoverage({
    from,
    to,
    granularity: query.scope.granularity,
    points: rendered,
    coveredFrom,
    coveredThrough,
  });

  return {
    scope: query.scope,
    semantics: {
      displayCurrency,
      measure: query.measure,
      segment: query.segment,
      sourceCurrencyPolicy: 'observations_retain_source_currency',
      knownTotalPolicy: PRICE_MEASURE_INCLUDES_DELIVERY[query.measure]
        ? 'offers_without_published_delivery_are_excluded'
        : 'delivery_excluded_from_this_measure',
      policyVersion: PRICE_HISTORY_POLICY_VERSION,
    },
    notice: PRICE_HISTORY_DISPLAY_NOTICE,
    points: rendered,
    gaps,
    uncovered,
    summary: summarize(rendered, gaps, query),
    table,
    ...(await currentOfferLink(rendered, now)),
    ...(rebuiltAt ? { rebuiltAt: rebuiltAt.toISOString() } : {}),
  };
}

/**
 * Turn the buckets nobody answered into RANGES (#78 API rule 4, acceptance 7).
 *
 * A gap and an unbuilt range are computed together because they are the same
 * subtraction with a different reason attached, and separating them is exactly
 * what stops a renderer drawing a line through the second: within the series'
 * coverage a missing bucket means nobody was offering the thing, and outside it
 * the rebuild has simply not reached there.
 */
function describeCoverage(input: {
  from: Date;
  to: Date;
  granularity: PriceHistoryQuery['scope']['granularity'];
  points: readonly PriceHistoryPoint[];
  coveredFrom?: Date;
  coveredThrough?: Date;
}): {
  gaps: PriceHistoryGap[];
  uncovered: PriceHistoryUncovered[];
  table: PriceHistoryTableRow[];
} {
  const answered = new Map(input.points.map((point) => [point.bucketStart, point]));
  const buckets = priceHistoryBuckets(input.from, input.to, input.granularity);

  const table: PriceHistoryTableRow[] = [];
  const gapRuns: Date[][] = [];
  const uncoveredRuns: Date[][] = [];
  let gapRun: Date[] = [];
  let uncoveredRun: Date[] = [];

  const flush = () => {
    if (gapRun.length > 0) gapRuns.push(gapRun);
    if (uncoveredRun.length > 0) uncoveredRuns.push(uncoveredRun);
    gapRun = [];
    uncoveredRun = [];
  };

  for (const bucket of buckets) {
    const bucketEnd = priceHistoryBucketEnd(bucket, input.granularity);
    const point = answered.get(bucket.toISOString());
    if (point) {
      flush();
      table.push({
        bucketStart: bucket.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
        value: point.value,
        offerId: point.offerId,
        observedAt: point.observedAt,
        state: 'observed',
      });
      continue;
    }

    const covered =
      input.coveredFrom !== undefined &&
      input.coveredThrough !== undefined &&
      bucketEnd.getTime() > input.coveredFrom.getTime() &&
      bucket.getTime() < input.coveredThrough.getTime();

    if (covered) {
      if (uncoveredRun.length > 0) {
        uncoveredRuns.push(uncoveredRun);
        uncoveredRun = [];
      }
      gapRun.push(bucket);
      table.push({
        bucketStart: bucket.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
        state: 'gap',
      });
    } else {
      if (gapRun.length > 0) {
        gapRuns.push(gapRun);
        gapRun = [];
      }
      uncoveredRun.push(bucket);
      table.push({
        bucketStart: bucket.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
        state: 'not_yet_built',
      });
    }
  }
  flush();

  const rangeOf = (run: Date[]): { from: string; to: string; buckets: number } => {
    const first = run[0];
    const last = run[run.length - 1];
    // Both are present by construction — a run is only pushed when non-empty —
    // and re-read through a guard because the compiler cannot see through the
    // array and a non-null assertion is forbidden.
    if (!first || !last) return { from: input.from.toISOString(), to: input.to.toISOString(), buckets: 0 };
    return {
      from: first.toISOString(),
      to: priceHistoryBucketEnd(last, input.granularity).toISOString(),
      buckets: run.length,
    };
  };

  return {
    gaps: gapRuns.map((run) => ({ ...rangeOf(run), reason: 'no_eligible_observation' as const })),
    uncovered: uncoveredRuns.map((run) => {
      const range = rangeOf(run);
      return { from: range.from, to: range.to, reason: 'not_yet_built' as const };
    }),
    table,
  };
}

/**
 * The plain-language rendering (#78 API rule 7).
 *
 * Every sentence names its SEGMENT and its RANGE, which is API rule 5: a
 * "lowest ever" with neither is a number that cannot be wrong because it does
 * not say what it is about.
 */
function summarize(
  points: readonly PriceHistoryPoint[],
  gaps: readonly PriceHistoryGap[],
  query: PriceHistoryQuery,
): PriceHistorySummary {
  const sentences: string[] = [];
  const first = points[0];
  const latest = points[points.length - 1];

  if (points.length === 0) {
    sentences.push(
      `No ${query.segment} price was observed for this ${query.scope.kind === 'canonical_product' ? 'product' : 'variant'} between ${query.from} and ${query.to}.`,
    );
    return { sentences, pointCount: 0, gapCount: gaps.length };
  }

  let lowest = points[0];
  let highest = points[0];
  for (const point of points) {
    if (lowest && point.value.money.amount < lowest.value.money.amount) lowest = point;
    if (highest && point.value.money.amount > highest.value.money.amount) highest = point;
  }

  sentences.push(
    `${points.length} ${query.segment} price observation${points.length === 1 ? '' : 's'} between ${query.from} and ${query.to}, shown in ${query.scope.displayCurrency}.`,
  );
  if (lowest) {
    sentences.push(
      `The lowest ${query.segment} price in this range was ${formatMinorUnits(lowest.value.money)} on ${lowest.observedAt}.`,
    );
  }
  if (latest) {
    sentences.push(`The most recent was ${formatMinorUnits(latest.value.money)} on ${latest.observedAt}.`);
  }
  if (gaps.length > 0) {
    const bucketCount = gaps.reduce((total, gap) => total + gap.buckets, 0);
    sentences.push(
      `${bucketCount} period${bucketCount === 1 ? '' : 's'} had no eligible offer and are shown as gaps rather than joined to the neighbouring points.`,
    );
  }

  return {
    sentences,
    pointCount: points.length,
    gapCount: gaps.length,
    ...(lowest
      ? {
          lowest: {
            value: lowest.value,
            segment: query.segment,
            measure: query.measure,
            from: query.from,
            to: query.to,
            offerId: lowest.offerId,
            observationId: lowest.observationId,
            observedAt: lowest.observedAt,
          },
        }
      : {}),
    ...(highest
      ? {
          highest: {
            value: highest.value,
            segment: query.segment,
            measure: query.measure,
            from: query.from,
            to: query.to,
            offerId: highest.offerId,
            observationId: highest.observationId,
            observedAt: highest.observedAt,
          },
        }
      : {}),
    ...(first ? { first } : {}),
    ...(latest ? { latest } : {}),
  };
}

/**
 * Minor units rendered in the currency's OWN precision (#78 currency rule 7).
 *
 * `CURRENCY_PRECISION` and never a hard-coded two. A zero-decimal currency's
 * minor unit IS its major unit, so dividing by a hundred would report one
 * hundredth of the price; an eight-decimal one would be off by six orders of
 * magnitude in the other direction. The map is the only thing that knows, and
 * naming a particular currency here would be the hard-coded assumption #78
 * currency rules 7 and 9 exist to keep out.
 */
function formatMinorUnits(money: Money): string {
  const precision = CURRENCY_PRECISION[money.currency];
  const major = money.amount / 10 ** precision;
  return `${major.toFixed(precision)} ${money.currency}`;
}

/**
 * The live offer a caller may follow from the newest point (#78 API rule 6).
 *
 * Re-derived rather than carried over from the rebuild, which is #68's whole
 * point: an offer that was current when a chart was built is exactly the one
 * that is not current when somebody clicks it. The link is ABSENT when the
 * offer no longer belongs in a comparison, so there is no "still eligible:
 * false" branch for a client to render as a live link with a warning.
 */
async function currentOfferLink(
  points: readonly PriceHistoryPoint[],
  now: Date,
): Promise<{ currentOffer?: { offerId: string; stillEligible: true } }> {
  const latest = points[points.length - 1];
  if (!latest) return {};

  const offer = await findOfferById(getDb(), latest.offerId);
  if (!offer || offer.status !== 'active') return {};

  const observation = {
    sourceId: await resolveOfferSourceId(offer.sourceRecordId),
    observedAt: offer.observedAt,
    firstSeenAt: offer.firstSeenAt,
    lastSeenAt: offer.lastSeenAt,
    lastConfirmedAt: offer.lastConfirmedAt,
    declaredUnavailableAt: offer.declaredUnavailableAt,
    storedExpiresAt: offer.staleAt,
  };

  const freshness =
    offer.kind === 'native'
      ? nativeOfferFreshness(observation, now)
      : assessOfferFreshness(
          observation,
          observation.sourceId === null
            ? null
            : ((await resolveSourceFreshnessPolicy(observation.sourceId))?.policy ?? null),
          now,
        );

  if (!mayAppearInComparison(freshness)) return {};
  return { currentOffer: { offerId: offer.id, stillEligible: true } };
}

/** The source behind one observation — the hop `offers` deliberately does not store. */
async function resolveOfferSourceId(sourceRecordId: string | null): Promise<string | null> {
  if (!sourceRecordId) return null;
  const rows = await getDb()
    .select({ sourceId: sourceRecords.sourceId })
    .from(sourceRecords)
    .where(eq(sourceRecords.id, sourceRecordId))
    .limit(1);
  return rows[0]?.sourceId ?? null;
}

/** The window a read may ask for, so a caller cannot request the whole history at once. */
export function clampPriceHistoryRange(from: Date, to: Date, now: Date): { from: Date; to: Date } {
  const window = rebuildWindow(now);
  const clampedFrom = from < window.from ? window.from : from;
  const clampedTo = to > now ? now : to;
  const maxSpanMs = config.priceHistory.maxQuerySpanDays * 24 * 60 * 60 * 1_000;
  if (clampedTo.getTime() - clampedFrom.getTime() > maxSpanMs) {
    return { from: new Date(clampedTo.getTime() - maxSpanMs), to: clampedTo };
  }
  return { from: clampedFrom, to: clampedTo };
}
