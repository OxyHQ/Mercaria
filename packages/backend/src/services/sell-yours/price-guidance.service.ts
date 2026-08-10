/**
 * Optional, explainable price guidance for a seller (#91 price guidance 1–5).
 *
 * ## Guidance is a range with a provenance, never a number to submit
 *
 * The shape is the enforcement: `SellerPriceGuidance` has no `suggestedPrice`,
 * no `recommended`, no `autoFill`, and each segment is a discriminated union
 * whose `insufficient_data` branch carries no figure at all. A screen therefore
 * cannot render "we suggest 240 ⊜" — there is nothing to read — and cannot
 * render a confident-looking range from two observations, because the sample
 * floor is applied here rather than left to whoever draws the bar.
 *
 * ## Four segments, four different sources, and each says which
 *
 * `current_same_condition`, `current_new` and `current_refurbished` are LIVE
 * eligible offers, read through #57's own `listOffers` — so a stale, retired or
 * moderation-restricted offer cannot appear in guidance, for the same reason it
 * cannot appear in a comparison, with no second eligibility rule to keep in
 * step. `recent_sold_native` is what Mercaria's own sellers actually got, read
 * from paid orders.
 *
 * ## The sold segment has TWO floors and the second one is about people
 *
 * A range over five sales that were all made by the same person is that
 * person's sales history republished to whoever asks — #77's disclosure-floor
 * reasoning on a different denominator. So `SELLER_SOLD_GUIDANCE_MIN_SAMPLE`
 * bounds how confident the number is and
 * `SELLER_SOLD_GUIDANCE_MIN_DISTINCT_SELLERS` bounds who it is about, and
 * neither substitutes for the other.
 *
 * ## What this module deliberately is NOT
 *
 * It is not a ranking input and cannot become one: nothing here writes a row,
 * and `sell-yours-isolation.test.ts` fails the build if a ranking, feed, search
 * or fee module reaches this domain. It also does not consume #82's price
 * signals, which are not built — {@link registerSellerPriceSignalProvider} is
 * the named seam, and its default reports NO signal rather than a zero.
 */

import type {
  ConditionGroup,
  CurrencyCode,
  Money,
  SellerPriceGuidance,
  SellerPriceGuidanceSegment,
  SellerPriceGuidanceSegmentKind,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  SELLER_GUIDANCE_MIN_SAMPLE,
  SELLER_PRICE_GUIDANCE_NOTICE,
  SELLER_SOLD_GUIDANCE_MIN_DISTINCT_SELLERS,
  SELLER_SOLD_GUIDANCE_MIN_SAMPLE,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { readRecentNativeSales } from '../../db/sellYours/guidanceRepository.js';
import { convert, getRates } from '../fx.service.js';
import { listOffers } from '../offers/offer.service.js';

/**
 * #82's seam, and it FAILS CLOSED.
 *
 * #82 owns derived price signals; nothing registers a provider today, so the
 * default answers "no signal" and the guidance is composed from live offers and
 * sold orders alone. A default that returned a neutral score would be worse than
 * absence: a screen cannot tell "the signal says this is a fair price" from "no
 * signal exists", and only one of those is true.
 */
export interface SellerPriceSignalProvider {
  readonly id: string;
  readonly describe: () => string;
}

let signalProvider: SellerPriceSignalProvider | null = null;

/** Register #82's provider. Called by nothing today, deliberately. */
export function registerSellerPriceSignalProvider(provider: SellerPriceSignalProvider): void {
  signalProvider = provider;
}

/** Whether a derived price signal is available at all. */
export function sellerPriceSignalProvider(): SellerPriceSignalProvider | null {
  return signalProvider;
}

/** How far back guidance looks. A window, stated on every response. */
const GUIDANCE_WINDOW_DAYS = 90;

/** A segment nobody could fill, with the reason it could not be filled. */
function insufficient(
  kind: SellerPriceGuidanceSegmentKind,
  conditionGroup: ConditionGroup,
  reason: 'no_observations' | 'below_sample_floor' | 'below_seller_floor',
): SellerPriceGuidanceSegment {
  return { kind, conditionGroup, state: 'insufficient_data', reason };
}

/**
 * Turn a sample of amounts into a range.
 *
 * The median rather than the mean, because a marketplace sample has a long right
 * tail — one optimistic asking price moves a mean and moves nothing else.
 */
function summarise(
  kind: SellerPriceGuidanceSegmentKind,
  conditionGroup: ConditionGroup,
  amounts: readonly number[],
  currency: CurrencyCode,
  floor: number,
): SellerPriceGuidanceSegment {
  if (amounts.length === 0) return insufficient(kind, conditionGroup, 'no_observations');
  if (amounts.length < floor) return insufficient(kind, conditionGroup, 'below_sample_floor');

  const sorted = [...amounts].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);

  return {
    kind,
    conditionGroup,
    state: 'available',
    low: { amount: sorted[0], currency },
    median: { amount: median, currency },
    high: { amount: sorted[sorted.length - 1], currency },
    sampleSize: sorted.length,
    /**
     * Confidence is a function of the SAMPLE and nothing else.
     *
     * Deliberately not of the spread: a wide range over thirty observations is a
     * genuinely wide market, and calling that "low confidence" would tell a
     * seller the data is bad when the data is fine and the market is broad.
     */
    confidence: sorted.length >= 20 ? 'high' : sorted.length >= 8 ? 'medium' : 'low',
  };
}

/** Every live eligible offer price in one condition group, in the asked currency. */
async function currentOfferAmounts(input: {
  readonly canonicalVariantId: string;
  readonly conditionGroup: ConditionGroup;
  readonly currency: CurrencyCode;
  readonly market?: string;
  readonly now: Date;
}): Promise<number[]> {
  const page = await listOffers({
    canonicalVariantId: input.canonicalVariantId,
    conditionGroups: [input.conditionGroup],
    ...(input.market ? { country: input.market } : {}),
    limit: config.sellYours.guidanceOfferSampleSize,
    now: input.now,
  });

  /**
   * An offer's currency is the OPEN set — a platform may publish a code
   * Mercaria does not list, which #57 records faithfully rather than refusing.
   * Guidance can only be composed from codes it can CONVERT, so anything outside
   * `ALL_CURRENCY_CODES` is excluded here, exactly as #78 excludes it from a
   * series under `currency_not_convertible`. The floors then account for the
   * smaller sample; treating the raw minor units as comparable would put 100 JPY
   * beside 100 EUR.
   */
  const priced: { amount: number; currency: CurrencyCode }[] = [];
  for (const offer of page.offers) {
    const price = offer.price;
    if (!price) continue;
    const currency = price.currency as CurrencyCode;
    if (!ALL_CURRENCY_CODES.includes(currency)) continue;
    priced.push({ amount: price.amount, currency });
  }
  if (priced.length === 0) return [];

  const rates = await getRates(input.currency, [
    ...new Set(priced.map((price) => price.currency)),
  ]);

  const amounts: number[] = [];
  for (const price of priced) {
    if (price.currency === input.currency) {
      amounts.push(price.amount);
      continue;
    }
    try {
      amounts.push(convert(price, input.currency, rates).amount);
    } catch {
      /**
       * A pair the rate map cannot serve is an OMISSION, never a zero and never
       * the unconverted figure.
       *
       * `convert` fails closed by design (`fx.service`), and the honest response
       * to "I cannot express that offer in your currency" is to leave it out of
       * the sample — which the floors above then account for. Including the raw
       * minor units would compare 100 JPY against 100 EUR.
       */
      continue;
    }
  }
  return amounts;
}

/**
 * Build the guidance for a draft.
 *
 * Every branch that cannot answer returns an `insufficient_data` segment rather
 * than omitting it, so a client renders "not enough data yet" for the segment
 * the seller asked about instead of silently showing three of four.
 */
export async function buildSellerPriceGuidance(input: {
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly conditionGroup: ConditionGroup;
  readonly currency: CurrencyCode;
  readonly market?: string;
  readonly now?: Date;
}): Promise<SellerPriceGuidance | undefined> {
  // An unmatched draft has no comparable set at all. Guidance built from
  // "listings whose titles look similar" is exactly the fuzzy comparison #58
  // refuses to merge on, wearing a price.
  if (!input.canonicalVariantId) return undefined;

  const now = input.now ?? new Date();
  const to = now;
  const from = new Date(now.getTime() - GUIDANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [sameCondition, newOffers, refurbishedOffers, sales] = await Promise.all([
    currentOfferAmounts({
      canonicalVariantId: input.canonicalVariantId,
      conditionGroup: input.conditionGroup,
      currency: input.currency,
      ...(input.market ? { market: input.market } : {}),
      now,
    }),
    currentOfferAmounts({
      canonicalVariantId: input.canonicalVariantId,
      conditionGroup: 'new',
      currency: input.currency,
      ...(input.market ? { market: input.market } : {}),
      now,
    }),
    currentOfferAmounts({
      canonicalVariantId: input.canonicalVariantId,
      conditionGroup: 'refurbished',
      currency: input.currency,
      ...(input.market ? { market: input.market } : {}),
      now,
    }),
    readRecentNativeSales({
      canonicalVariantId: input.canonicalVariantId,
      conditionGroup: input.conditionGroup,
      from,
      to,
      limit: config.sellYours.guidanceSoldSampleSize,
    }),
  ]);

  const segments: SellerPriceGuidanceSegment[] = [
    summarise(
      'current_same_condition',
      input.conditionGroup,
      sameCondition,
      input.currency,
      SELLER_GUIDANCE_MIN_SAMPLE,
    ),
    summarise('current_new', 'new', newOffers, input.currency, SELLER_GUIDANCE_MIN_SAMPLE),
    summarise(
      'current_refurbished',
      'refurbished',
      refurbishedOffers,
      input.currency,
      SELLER_GUIDANCE_MIN_SAMPLE,
    ),
    await soldSegment(sales, input.conditionGroup, input.currency),
  ];

  return {
    ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}),
    canonicalVariantId: input.canonicalVariantId,
    ...(input.market ? { market: input.market } : {}),
    currency: input.currency,
    from: from.toISOString(),
    to: to.toISOString(),
    segments,
    notice: SELLER_PRICE_GUIDANCE_NOTICE,
  };
}

/**
 * The sold segment, with the privacy floor applied BEFORE the sample floor.
 *
 * Order matters for the reason it always does with a disclosure floor: reporting
 * `below_sample_floor` for a set that also failed the seller floor would tell
 * the caller how many sales there were, which is the fact the seller floor
 * exists to withhold.
 */
async function soldSegment(
  sales: { readonly amounts: readonly Money[]; readonly distinctSellers: number },
  conditionGroup: ConditionGroup,
  currency: CurrencyCode,
): Promise<SellerPriceGuidanceSegment> {
  if (sales.amounts.length === 0) {
    return insufficient('recent_sold_native', conditionGroup, 'no_observations');
  }
  if (sales.distinctSellers < SELLER_SOLD_GUIDANCE_MIN_DISTINCT_SELLERS) {
    return insufficient('recent_sold_native', conditionGroup, 'below_seller_floor');
  }

  const currencies = [...new Set(sales.amounts.map((money) => money.currency))];
  const rates = await getRates(currency, currencies);
  const amounts: number[] = [];
  for (const money of sales.amounts) {
    if (money.currency === currency) {
      amounts.push(money.amount);
      continue;
    }
    try {
      amounts.push(convert(money, currency, rates).amount);
    } catch {
      // Same omission rule as the offer sample above: an unservable pair leaves
      // the observation out rather than mixing minor units across currencies.
      continue;
    }
  }

  return summarise(
    'recent_sold_native',
    conditionGroup,
    amounts,
    currency,
    SELLER_SOLD_GUIDANCE_MIN_SAMPLE,
  );
}
