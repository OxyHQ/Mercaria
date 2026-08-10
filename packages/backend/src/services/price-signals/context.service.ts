/**
 * Gathering everything a signal derivation reads — the ONE impure layer of #82.
 *
 * It does the five reads (offers, freshness-aware eligibility, price history,
 * seller identities, verified official channels), converts every amount into the
 * subject's currency ONCE, and hands the pure core values. Nothing below this
 * file opens a connection, and `derivePriceSignals` takes no clock — which is
 * what makes acceptance 4's "reproducible from immutable observations and a
 * policy version" a property of the call graph.
 *
 * ## The eligibility half is #74's, and no part of it is re-derived here
 *
 * "Exclude stale, quarantined, suppressed and ineligible observations" (issue
 * statistical policy 1) is answered by `selectEligibleOffers` for the CURRENT
 * half and by #78's `derivePointsForScope` for the HISTORICAL half. Both are the
 * single authority in their own domain, and a third spelling here would be wrong
 * for exactly as long as the three disagreed — which is the window in which a
 * jury has restricted a listing.
 *
 * What this file may import from `services/ranking/` is therefore narrow and
 * gated: `eligibility.ts`, `facts.ts` and `money.ts` — the ADMISSION half. The
 * policy, the score, the labels and the dominance detector are unreachable from
 * here, and `price-signal-isolation.test.ts` fails the build on any of them.
 * That narrowing is #74's own precedent, which allowed exactly one module to
 * reach #55's relationship domain and no others.
 */

import {
  ALL_CURRENCY_CODES,
  hasKnownPrice,
  type ConditionGroup,
  type CurrencyCode,
  type FxRates,
  type Offer,
  type PriceHistoryValue,
  type PriceSignalPolicy,
} from '@mercaria/shared-types';
import { convert, getRates, pairRate } from '../fx.service.js';
import { listOffers } from '../offers/offer.service.js';
import { derivePointsForScope } from '../price-history/rebuild.service.js';
import { selectEligibleOffers } from '../ranking/eligibility.js';
import { buildOfferRankingFacts, buildRankingFactContext } from '../ranking/facts.js';
import { convertOfferMoney } from '../ranking/money.js';
import { listOfficialStoreMerchantIds } from '../../db/priceHistory/priceEligibilityRepository.js';
import { listOfferSellerIdentities } from '../../db/priceSignals/priceSignalSubjectRepository.js';
import { config } from '../../config/index.js';
import { sellerDedupKey, type PriceSampleEntry } from './statistics.js';
import type { PriceSignalDerivationInput, PriceSignalScope } from './signals.js';

/** What a caller asks the context layer for. */
export interface PriceSignalContextRequest {
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly segment: ConditionGroup;
  readonly market?: string;
  readonly currency: CurrencyCode;
  /** The merchant whose own offer is the FOCUS, or absent for the market's best. */
  readonly focusMerchantId?: string;
  readonly policy?: PriceSignalPolicy;
  readonly now: Date;
}

/** The derivation input, plus the offers behind it for a caller that needs them. */
export interface PriceSignalContext {
  readonly input: PriceSignalDerivationInput;
  /** Every offer considered, by id — the ELIGIBLE ones and the refused ones. */
  readonly offers: ReadonlyMap<string, Offer>;
  /** Why each refused offer was refused, so a merchant surface can report it. */
  readonly exclusions: ReadonlyMap<string, readonly string[]>;
  /**
   * The focus merchant's OWN observed price, whether or not their offer is
   * eligible — and deliberately NOT part of {@link PriceSignalDerivationInput}.
   *
   * The competitiveness surface needs it for exactly one claim: "at this observed
   * price, your offer WOULD be the cheapest", which is only worth saying to a
   * merchant whose offer is currently refused. Feeding it to the pure core
   * instead would let an ineligible price enter a public comparison, which is the
   * one thing #74's admission exists to prevent — so it travels beside the input
   * rather than inside it.
   */
  readonly focusObservedItemPrice?: PriceSampleEntry;
  /** The figure for {@link focusObservedItemPrice}, carrying its FX basis. */
  readonly focusObservedItemValue?: PriceHistoryValue;
}

/**
 * Read everything one subject's signals are derived from.
 *
 * The window is the POLICY's `recentWindowDays`, so "recent" means the same thing
 * to the derivation and to the read that gathered its sample. With no active
 * policy there is nothing to gather for, and the caller is handed an empty
 * context whose every signal is `unmeasured`/`no_active_policy` — a read that
 * cost one query rather than five.
 */
export async function buildPriceSignalContext(
  request: PriceSignalContextRequest,
): Promise<PriceSignalContext> {
  const scope: PriceSignalScope = {
    scopeKind: request.canonicalVariantId === undefined ? 'canonical_product' : 'canonical_variant',
    ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
    ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
    segment: request.segment,
    ...(request.market === undefined ? {} : { market: request.market }),
    currency: request.currency,
    from: request.now.toISOString(),
    to: request.now.toISOString(),
    focus: request.focusMerchantId === undefined ? 'market_best' : 'seller',
  };

  if (request.policy === undefined) {
    return {
      input: emptyInput(scope),
      offers: new Map(),
      exclusions: new Map(),
    };
  }

  const windowMs = request.policy.recentWindowDays * 24 * 60 * 60 * 1_000;
  const from = new Date(request.now.getTime() - windowMs);
  const scoped: PriceSignalScope = { ...scope, from: from.toISOString() };

  // ── The current half, through #74's admission ────────────────────────────
  const page = await listOffers({
    ...(request.canonicalVariantId ? { canonicalVariantId: request.canonicalVariantId } : {}),
    ...(request.canonicalProductId ? { canonicalProductId: request.canonicalProductId } : {}),
    ...(request.market ? { country: request.market.toUpperCase() } : {}),
    conditionGroups: [request.segment],
    // A merchant asking why their offer is missing needs the offer to be in the
    // set at all, so the stale ones are fetched and REFUSED by the derivation
    // rather than dropped by the query — #74's `diagnostic` mode, taken always
    // here because "losing eligibility" is one of this domain's own outputs.
    includeStale: true,
    limit: config.priceSignals.offerSampleLimit,
    now: request.now,
  });

  const quotes = [
    ...new Set(
      page.offers.flatMap((offer) => [
        offer.price?.currency,
        offer.delivery.known ? offer.delivery.cost.currency : undefined,
      ]),
    ),
  ].filter((currency): currency is CurrencyCode =>
    currency !== undefined && (ALL_CURRENCY_CODES as readonly string[]).includes(currency),
  );
  const rates = await getRates(request.currency, quotes);

  const factContext = await buildRankingFactContext({
    offers: page.offers,
    comparisonCurrency: request.currency,
    rates,
    ...(request.market === undefined ? {} : { market: request.market }),
    now: request.now,
  });

  const selection = selectEligibleOffers({
    offers: page.offers,
    context: {
      canonicalVariantIds: new Set(page.offers.map((offer) => offer.canonicalVariantId)),
      ...(request.market === undefined ? {} : { market: request.market.toUpperCase() }),
      customerClasses: [],
      experience: 'buy_now',
      conditionGroups: [request.segment],
      suppressedMerchantIds: factContext.suppressedMerchantIds,
      suppressedStorefrontIds: factContext.suppressedStorefrontIds,
    },
    buildFacts: (offer) => buildOfferRankingFacts(offer, factContext),
  });

  const offers = new Map(page.offers.map((offer) => [offer.id, offer]));
  const eligibleIds = new Set(selection.eligible.map((admitted) => admitted.offerId));
  const values = new Map<string, PriceHistoryValue>();

  const currentItemPrice: PriceSampleEntry[] = [];
  const currentKnownTotal: PriceSampleEntry[] = [];

  for (const offer of page.offers) {
    if (!eligibleIds.has(offer.id)) continue;
    const seller = sellerDedupKey({
      ...(offer.merchantId === undefined ? {} : { merchantId: offer.merchantId }),
      ...(offer.listingId === undefined ? {} : { listingId: offer.listingId }),
    });
    // A seller Mercaria cannot identify is EXCLUDED rather than given a key of
    // its own: a per-offer fallback inflates the distinct-seller count in the one
    // direction that makes a weak sample look strong.
    if (seller === undefined) continue;

    const itemPrice = convertOfferMoney(offer.price, request.currency, rates);
    if (hasKnownPrice(itemPrice) && offer.price !== undefined) {
      const id = `offer:${offer.id}`;
      currentItemPrice.push({
        id,
        offerId: offer.id,
        sellerKey: seller,
        amount: itemPrice.amount.amount,
        observedAt: request.now,
      });
      values.set(
        id,
        priceValue(
          { amount: offer.price.amount, currency: offer.price.currency },
          itemPrice.amount.amount,
          request.currency,
          rates,
        ),
      );
    }

    // The known TOTAL is composed in the ITEM's own currency first, so the value
    // has one native amount to record — #78's rule, and for its reason:
    // converting each half straight to the display currency leaves a total whose
    // native half exists in no currency at all.
    if (offer.price !== undefined && offer.delivery.known) {
      const nativeTotal = nativeKnownTotal(offer, rates);
      if (nativeTotal !== undefined) {
        const converted = convertOfferMoney(nativeTotal, request.currency, rates);
        if (hasKnownPrice(converted)) {
          const id = `total:${offer.id}`;
          currentKnownTotal.push({
            id,
            offerId: offer.id,
            sellerKey: seller,
            amount: converted.amount.amount,
            observedAt: request.now,
          });
          values.set(
            id,
            priceValue(nativeTotal, converted.amount.amount, request.currency, rates),
          );
        }
      }
    }
  }

  // ── The historical half, through #78's own derivation ────────────────────
  const derived = await derivePointsForScope(
    {
      ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
      ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
      ...(request.market === undefined ? {} : { market: request.market }),
      ...(request.focusMerchantId === undefined ? {} : { merchantId: request.focusMerchantId }),
      displayCurrency: request.currency,
      granularity: 'day',
    },
    { from, to: request.now },
    request.now,
  );

  const historyOfferIds = [...new Set(derived.points.map((point) => point.offerId))];
  const identities = await listOfferSellerIdentities(historyOfferIds);

  const historyItemPrice: PriceSampleEntry[] = [];
  const historyKnownTotal: PriceSampleEntry[] = [];
  for (const point of derived.points) {
    if (point.segment !== request.segment) continue;
    const identity = identities.get(point.offerId);
    const seller =
      identity === undefined
        ? undefined
        : sellerDedupKey({
            ...(identity.merchantId === null ? {} : { merchantId: identity.merchantId }),
            ...(identity.listingId === null ? {} : { listingId: identity.listingId }),
          });
    if (seller === undefined) continue;

    const entry: PriceSampleEntry = {
      id: point.snapshotId,
      offerId: point.offerId,
      sellerKey: seller,
      amount: point.displayAmount,
      observedAt: point.observedAt,
    };
    const value: PriceHistoryValue =
      point.fx === undefined
        ? {
            basis: 'source_native',
            money: { amount: point.displayAmount, currency: request.currency },
            native: { amount: point.native.amount, currency: point.native.currency },
          }
        : {
            basis: 'historical_quote',
            money: { amount: point.displayAmount, currency: request.currency },
            native: { amount: point.native.amount, currency: point.native.currency },
            quote: {
              from: point.fx.from,
              to: point.fx.to,
              rate: point.fx.rate,
              provider: point.fx.provider,
              asOf: point.fx.asOf.toISOString(),
            },
          };

    if (point.measure === 'lowest_item_price') {
      historyItemPrice.push(entry);
      values.set(entry.id, value);
    } else if (point.measure === 'lowest_known_total') {
      // A known-total point and an item-price point can name the SAME
      // observation, so the map is keyed per measure — otherwise the second
      // write would silently replace the first and one series would render the
      // other's figure.
      const id = `total:${point.snapshotId}`;
      historyKnownTotal.push({ ...entry, id });
      values.set(id, value);
    }
  }

  // ── The verified official channels (#55), through #78's own reader ────────
  const officialMerchantIds = await listOfficialStoreMerchantIds(
    {
      canonicalProductId: request.canonicalProductId ?? null,
      canonicalVariantId: request.canonicalVariantId ?? null,
    },
    request.now,
  );
  const officialSellerKeys = new Set(
    [...officialMerchantIds].map((merchantId) => `merchant:${merchantId}`),
  );

  const focusSellerKey =
    request.focusMerchantId === undefined ? undefined : `merchant:${request.focusMerchantId}`;
  const focusItemPrice = pickFocus(currentItemPrice, focusSellerKey);
  const focusKnownTotal = pickFocus(currentKnownTotal, focusSellerKey);

  // The focus merchant's own price, eligible or not. Built here because this is
  // the only layer holding the rate map, and kept OUT of the derivation input for
  // the reason `PriceSignalContext` states.
  let focusObservedItemPrice: PriceSampleEntry | undefined;
  let focusObservedItemValue: PriceHistoryValue | undefined;
  if (request.focusMerchantId !== undefined && focusSellerKey !== undefined) {
    const own = page.offers
      .filter((offer) => offer.merchantId === request.focusMerchantId && offer.price !== undefined)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const offer of own) {
      const converted = convertOfferMoney(offer.price, request.currency, rates);
      if (!hasKnownPrice(converted) || offer.price === undefined) continue;
      focusObservedItemPrice = {
        id: `observed:${offer.id}`,
        offerId: offer.id,
        sellerKey: focusSellerKey,
        amount: converted.amount.amount,
        observedAt: request.now,
      };
      focusObservedItemValue = priceValue(
        { amount: offer.price.amount, currency: offer.price.currency },
        converted.amount.amount,
        request.currency,
        rates,
      );
      break;
    }
  }

  return {
    input: {
      scope: scoped,
      policy: request.policy,
      currentItemPrice,
      currentKnownTotal,
      historyItemPrice,
      historyKnownTotal,
      ...(focusItemPrice === undefined ? {} : { focusItemPrice }),
      ...(focusKnownTotal === undefined ? {} : { focusKnownTotal }),
      officialSellerKeys,
      values,
    },
    offers,
    exclusions: new Map(
      selection.excluded.map((verdict) => [verdict.offerId, verdict.reasons] as const),
    ),
    ...(focusObservedItemPrice === undefined ? {} : { focusObservedItemPrice }),
    ...(focusObservedItemValue === undefined ? {} : { focusObservedItemValue }),
  };
}

/**
 * The entry the signals are ABOUT.
 *
 * With no focus seller it is the CHEAPEST eligible offer — what a shopper on the
 * product page would actually pay — and with one it is that seller's own,
 * whatever its position. A merchant asking "how does my price compare" is not
 * asking about the market's best.
 */
function pickFocus(
  entries: readonly PriceSampleEntry[],
  focusSellerKey: string | undefined,
): PriceSampleEntry | undefined {
  const candidates =
    focusSellerKey === undefined
      ? entries
      : entries.filter((entry) => entry.sellerKey === focusSellerKey);
  return [...candidates].sort((left, right) => {
    if (left.amount !== right.amount) return left.amount - right.amount;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0];
}

/** Item plus published delivery, in the ITEM's own currency. */
function nativeKnownTotal(
  offer: Offer,
  rates: FxRates,
): { amount: number; currency: string } | undefined {
  const price = offer.price;
  if (price === undefined || !offer.delivery.known) return undefined;
  const itemCurrency = asCurrencyCode(price.currency);
  const deliveryCurrency = asCurrencyCode(offer.delivery.cost.currency);
  if (itemCurrency === null || deliveryCurrency === null) return undefined;
  if (!canQuote(itemCurrency, rates) || !canQuote(deliveryCurrency, rates)) return undefined;

  const delivery = convert(
    { amount: offer.delivery.cost.amount, currency: deliveryCurrency },
    itemCurrency,
    rates,
  );
  return { amount: price.amount + delivery.amount, currency: price.currency };
}

/**
 * A publishable figure, carrying #78's FX basis.
 *
 * `source_native` when nothing was converted, `historical_quote` when it was —
 * with the quote that produced it. There is no branch that returns a converted
 * amount without a rate, which is #78 currency rules 4 and 5 surviving the last
 * hop to a badge.
 */
function priceValue(
  native: { amount: number; currency: string },
  displayAmount: number,
  displayCurrency: CurrencyCode,
  rates: FxRates,
): PriceHistoryValue {
  if (native.currency === displayCurrency) {
    return {
      basis: 'source_native',
      money: { amount: displayAmount, currency: displayCurrency },
      native,
    };
  }
  const from = asCurrencyCode(native.currency);
  if (from === null) {
    // Unreachable: an entry only exists once `convertOfferMoney` succeeded, which
    // needs a `CurrencyCode`. Written out because a non-null assertion is
    // forbidden, and answering `source_native` here would be the one lie this
    // union exists to prevent — so it answers with the identity quote instead,
    // which is at least true of the number it carries.
    return {
      basis: 'source_native',
      money: { amount: displayAmount, currency: displayCurrency },
      native,
    };
  }
  return {
    basis: 'historical_quote',
    money: { amount: displayAmount, currency: displayCurrency },
    native,
    quote: {
      from,
      to: displayCurrency,
      rate: pairRate(from, displayCurrency, rates),
      provider: rates.provider,
      asOf: rates.asOf,
    },
  };
}

function asCurrencyCode(currency: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(currency)
    ? (currency as CurrencyCode)
    : null;
}

function canQuote(currency: CurrencyCode, rates: FxRates): boolean {
  if (currency === rates.base) return true;
  const rate = rates.rates[currency];
  return rate !== undefined && rate > 0;
}

/** The context a deployment with no active policy hands the derivation. */
function emptyInput(scope: PriceSignalScope): PriceSignalDerivationInput {
  return {
    scope,
    currentItemPrice: [],
    currentKnownTotal: [],
    historyItemPrice: [],
    historyKnownTotal: [],
    officialSellerKeys: new Set(),
    values: new Map(),
  };
}
