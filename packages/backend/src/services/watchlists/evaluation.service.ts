/**
 * Evaluating one watchlist into a basket (#81 "Current basket calculation").
 *
 * This is the impure half: it reads the catalogue, calls #74's comparison per
 * item, and hands values to the pure modules beside it. Everything it decides is
 * decided in `selection.ts` and `totals.ts`, which is why those can be tested
 * without a database and why this file has no arithmetic in it.
 *
 * ## A failure while pricing ONE item is that item's, not the request's
 *
 * #81 acceptance 7 — "list evaluation failures do not prevent editing or opening
 * the list" — is held in two places, and neither is a `try` around the response.
 * The list READ (`watchlist.service.readWatchlist`) never calls this file at
 * all, so a comparison that is down cannot stop somebody opening or editing
 * their list; and inside this file every per-item call is isolated
 * (`evaluateOneItem` catches, logs and returns `evaluation_failed`), so a
 * basket with one broken item is a basket with one broken item. Nothing
 * rethrows: a page that aborted on its worst item would report nothing about the
 * ten that priced fine, which is #60's per-record isolation rule applied to a
 * read.
 *
 * ## Eligible offers come from #74 and are not re-derived
 *
 * `rankOfferComparison` applies #57's `deriveNativeCheckoutEligibility`, #68's
 * freshness, #55's relationships and #90's condition filters, and returns the
 * policy version that produced the order. This file reads its output and asks
 * `listOffers` exactly ONE further question, in exactly one case: when the
 * comparison came back empty, "were there ever any" — because
 * `no_offers_recorded` and `all_offers_retired` send a buyer to completely
 * different places (#80's `best-offer.ts`, same probe, same reason). That probe
 * never selects anything.
 *
 * ## The catalogue is read ONCE for the whole list
 *
 * Products and preferred variants are fetched in two batched statements before
 * any comparison runs, so the derived states below (`product_unavailable`,
 * `preferred_variant_retired`, `product_merged_into_existing_item`) cost nothing
 * per item. Those three are DERIVED rather than stored, which is the
 * `deriveNativeCheckoutEligibility` divergence: their inputs live on
 * `canonical_products` and `canonical_variants`, tables this domain does not
 * own, so a stored copy would be a second answer that goes stale the moment a
 * merge runs.
 */

import {
  hasKnownDelivery,
  hasKnownPrice,
  WATCHLIST_BASKET_OPTIMIZATION_SEAM,
  type FxRateSnapshot,
  type Money,
  type OfferComparisonPrice,
  type WatchlistBasket,
  type WatchlistBasketLine,
  type WatchlistDeliveryComponent,
  type WatchlistItem,
  type WatchlistItemEvaluation,
  type WatchlistItemPriceChange,
  type WatchlistItemSelection,
  type WatchlistItemUnresolvedReason,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findCanonicalProductsByIds } from '../../db/canonical/canonicalProductRepository.js';
import { findCanonicalVariantsByIds } from '../../db/canonical/canonicalVariantRepository.js';
import type { WatchlistItemFactsRow } from '../../db/watchlists/watchlistItemRepository.js';
import type { WatchlistRow } from '../../db/watchlists/watchlistRepository.js';
import type { WatchlistSnapshotItemRow } from '../../db/watchlists/watchlistSnapshotRepository.js';
import { listOffers } from '../offers/offer.service.js';
import { rankOfferComparison } from '../ranking/comparison.service.js';
import { selectWatchlistOffer } from './selection.js';
import {
  composeWatchlistTotal,
  multiplyMoneyByQuantity,
  resolveWatchlistTarget,
  type WatchlistTotalLine,
} from './totals.js';

/**
 * How many offers of one product the comparison reads before choosing.
 *
 * #80's figure, for its reason: the read is cheapest-first, so the answer is
 * usually the first row, and the page exists only because the merchant
 * preference is applied in JavaScript. Larger would buy nothing; smaller would
 * make a preferred seller invisible behind a handful of cheaper strangers.
 */
const OFFER_SCAN_LIMIT = 25;

/** The prior evaluation one basket is compared against, reduced to what it needs. */
export interface WatchlistPriorSnapshot {
  readonly id: string;
  readonly displayCurrency: string;
  readonly rankingPolicyVersions: readonly string[];
  readonly evaluatedAt: Date;
  readonly lines: readonly WatchlistSnapshotItemRow[];
}

/** What an evaluation is handed. */
export interface EvaluateWatchlistInput {
  readonly watchlist: WatchlistRow;
  /** Every item, WITHOUT its note — see `watchlistItemRepository`. */
  readonly items: readonly WatchlistItemFactsRow[];
  /** The projected items, in the same order, for the basket's own lines. */
  readonly projected: readonly WatchlistItem[];
  readonly prior?: WatchlistPriorSnapshot;
  readonly now?: Date;
}

/** One item's evaluated outcome, plus what it contributed. */
interface ItemOutcome {
  readonly evaluation: WatchlistItemEvaluation;
  readonly rates: readonly FxRateSnapshot[];
  readonly policyVersion?: string;
}

/** The catalogue facts the derived states are read from. */
interface CatalogueContext {
  readonly productStatus: ReadonlyMap<string, { status: string; mergedIntoId: string | null }>;
  readonly variantStatus: ReadonlyMap<string, { status: string; mergedIntoId: string | null }>;
  /** Every canonical product this LIST holds — the duplicate-after-merge probe. */
  readonly productsInList: ReadonlySet<string>;
}

/**
 * A canonical entity a buyer can still be shown offers for.
 *
 * `draft` and `discontinued` are deliberately admitted: a discontinued product
 * with live offers is exactly the thing somebody watches a list for, and
 * refusing it here would empty a basket over a catalogue label rather than over
 * an offer. `merged` and `suppressed` are not — the first is a tombstone whose
 * identity has moved and the second is an operator's "do not show".
 */
function resolvesLive(status: string): boolean {
  return status !== 'merged' && status !== 'suppressed';
}

/** Read the catalogue once for the whole list. */
async function loadCatalogueContext(
  items: readonly WatchlistItemFactsRow[],
): Promise<CatalogueContext> {
  const db = getDb();
  const productIds = [...new Set(items.map((item) => item.canonicalProductId))];
  const variantIds = [
    ...new Set(
      items
        .map((item) => item.preferredCanonicalVariantId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];

  const [products, variants] = await Promise.all([
    findCanonicalProductsByIds(db, productIds),
    findCanonicalVariantsByIds(db, variantIds),
  ]);

  return {
    productStatus: new Map(
      products.map((row) => [row.id, { status: row.status, mergedIntoId: row.mergedIntoId }]),
    ),
    variantStatus: new Map(
      variants.map((row) => [row.id, { status: row.status, mergedIntoId: row.mergedIntoId }]),
    ),
    productsInList: new Set(productIds),
  };
}

/**
 * Why this item cannot be priced from the catalogue alone, if it cannot.
 *
 * The order is severity, and it is the `deriveRetailCompleteness` rule: an
 * unanswered split beats a retired variant beats an unavailable product, because
 * each earlier one makes the later question meaningless. A duplicate created by
 * a merge is reported as its own reason rather than as `product_unavailable`,
 * because the buyer's remedy is to delete a row rather than to wait for stock.
 */
function catalogueRefusal(
  item: WatchlistItemFactsRow,
  context: CatalogueContext,
): WatchlistItemUnresolvedReason | undefined {
  if (item.resolutionState === 'ambiguous_after_split') return 'ambiguous_after_split';

  const product = context.productStatus.get(item.canonicalProductId);
  if (product === undefined) return 'product_unavailable';
  if (!resolvesLive(product.status)) {
    // A merge rehomes an entry unless the SAME list already holds the winner
    // (#59's `repoint_if_absent`, guarded on `watchlist_id`). That is the only
    // way an entry legitimately stays on a tombstone, and the buyer is told to
    // remove a duplicate rather than being charged for one product twice.
    if (
      product.status === 'merged' &&
      product.mergedIntoId !== null &&
      context.productsInList.has(product.mergedIntoId)
    ) {
      return 'product_merged_into_existing_item';
    }
    return 'product_unavailable';
  }

  const variantId = item.preferredCanonicalVariantId;
  if (variantId !== null && variantId !== undefined) {
    const variant = context.variantStatus.get(variantId);
    // #81 correction rule 3: a retired configuration falls back to the
    // product-level UNRESOLVED state and never to another variant. Silently
    // widening the scope back to the product would price a different thing under
    // the buyer's own pin.
    if (variant === undefined || !resolvesLive(variant.status)) return 'preferred_variant_retired';
  }

  return undefined;
}

/** The delivery half of one selected offer, converted or honestly absent. */
function deliveryFor(cost: OfferComparisonPrice, quantity: number): WatchlistDeliveryComponent {
  if (!hasKnownPrice(cost)) return { known: false, reason: cost.reason };
  return {
    known: true,
    unit: cost.amount,
    line: multiplyMoneyByQuantity(cost.amount, quantity, 'watchlist.delivery'),
    fx: cost.fx,
  };
}

/** Price ONE item. Never throws — see the module docblock. */
async function evaluateOneItem(
  watchlist: WatchlistRow,
  item: WatchlistItemFactsRow,
  context: CatalogueContext,
): Promise<ItemOutcome> {
  const refusal = catalogueRefusal(item, context);
  if (refusal !== undefined) {
    return { evaluation: { state: 'unresolved', reason: refusal }, rates: [] };
  }

  try {
    const scope =
      item.preferredCanonicalVariantId === null || item.preferredCanonicalVariantId === undefined
        ? { canonicalProductId: item.canonicalProductId }
        : { canonicalVariantId: item.preferredCanonicalVariantId };

    const comparison = await rankOfferComparison({
      ...scope,
      comparisonCurrency: watchlist.displayCurrency,
      intent: 'cheapest',
      ...(watchlist.market === null || watchlist.market === undefined
        ? {}
        : { market: watchlist.market }),
      ...(item.preferredConditionGroup === null || item.preferredConditionGroup === undefined
        ? {}
        : { conditionGroups: [item.preferredConditionGroup] }),
      limit: OFFER_SCAN_LIMIT,
    });

    if (comparison.comparison.offers.length === 0) {
      // Offers came back and eligibility refused every one of them: the buyer's
      // own filters, a moderation restriction, a seller who cannot be paid. The
      // remedy is theirs, so it is reported as theirs.
      if (comparison.offers.size > 0) {
        return { evaluation: { state: 'unresolved', reason: 'no_eligible_offer' }, rates: [] };
      }
      // The EXISTENCE probe, and the only second read this file makes. It
      // selects nothing and its answer only ever changes which reason is
      // reported — `all_offers_retired` sends a buyer to wait, and
      // `no_offers_recorded` sends them to look elsewhere entirely.
      const everRecorded = await listOffers({ ...scope, limit: 1, includeStale: true });
      return {
        evaluation: {
          state: 'unresolved',
          reason: everRecorded.offers.length === 0 ? 'no_offers_recorded' : 'all_offers_retired',
        },
        rates: [],
      };
    }

    const selected = selectWatchlistOffer({
      ranked: comparison.comparison.offers,
      offers: comparison.offers,
      preferredMerchantId: item.preferredMerchantId,
    });

    if (selected.state === 'none') {
      return {
        evaluation: { state: 'unresolved', reason: selected.reason },
        rates: [],
        policyVersion: comparison.comparison.policy.version,
      };
    }

    const itemPrice = selected.ranked.cost.itemPrice;
    if (!hasKnownPrice(itemPrice)) {
      // Unreachable through `selectWatchlistOffer`, which only returns a row
      // whose price is known. Stated rather than asserted so the narrowing is
      // the compiler's rather than a comment's.
      return {
        evaluation: { state: 'unresolved', reason: 'price_not_convertible' },
        rates: [],
        policyVersion: comparison.comparison.policy.version,
      };
    }

    const delivery = deliveryFor(selected.ranked.cost.deliveryCost, item.quantity);
    const selection: WatchlistItemSelection = {
      offerId: selected.offer.id,
      canonicalVariantId: selected.offer.canonicalVariantId,
      availability: selected.offer.availability,
      ...(selected.offer.condition.group ? { conditionGroup: selected.offer.condition.group } : {}),
      ...(selected.offer.merchantId ? { merchantId: selected.offer.merchantId } : {}),
      nativeCheckoutEligible: selected.offer.checkout.eligible,
      rankingPolicyVersion: comparison.comparison.policy.version,
      unitItemPrice: itemPrice.amount,
      unitItemPriceFx: itemPrice.fx,
      lineItemPrice: multiplyMoneyByQuantity(
        itemPrice.amount,
        item.quantity,
        'watchlist.itemPrice',
      ),
      delivery,
      taxInclusion: selected.ranked.cost.taxInclusion,
    };

    return {
      evaluation: { state: 'priced', selection },
      rates: hasKnownDelivery(delivery) ? [itemPrice.fx, delivery.fx] : [itemPrice.fx],
      policyVersion: comparison.comparison.policy.version,
    };
  } catch (err) {
    // #81 acceptance 7. The failure becomes this ITEM's reason so the rest of
    // the basket still answers, and it is logged with the item so an operator
    // can find it — the basket itself carries no detail, because a buyer cannot
    // act on one.
    log.general.error(
      { err, watchlistId: item.watchlistId, itemId: item.id },
      'Failed to evaluate one watchlist item',
    );
    return { evaluation: { state: 'unresolved', reason: 'evaluation_failed' }, rates: [] };
  }
}

/**
 * How this item's unit price moved since the prior snapshot measured it.
 *
 * Every axis that could make the two incomparable is checked BEFORE the
 * subtraction, and each answers with its own reason: a different display
 * currency, a different #74 policy version (which can select a different offer
 * at unchanged prices), or a line that was not priced on one of the two sides.
 * Reporting a movement across any of them would attribute to the item a change
 * the item did not make — the same objection the snapshot diff refuses on.
 */
function priceChangeFor(
  itemId: string,
  evaluation: WatchlistItemEvaluation,
  displayCurrency: string,
  policyVersion: string | undefined,
  prior: WatchlistPriorSnapshot | undefined,
): WatchlistItemPriceChange {
  if (prior === undefined) return { known: false, reason: 'no_prior_snapshot' };
  if (prior.displayCurrency !== displayCurrency) return { known: false, reason: 'currency_changed' };
  if (evaluation.state !== 'priced') return { known: false, reason: 'not_priced_in_prior_snapshot' };

  const line = prior.lines.find((candidate) => candidate.watchlistItemId === itemId);
  if (line === undefined || line.state !== 'priced' || line.unitItemPriceAmount === null) {
    return { known: false, reason: 'not_priced_in_prior_snapshot' };
  }
  if (policyVersion !== undefined && line.rankingPolicyVersion !== policyVersion) {
    return { known: false, reason: 'policy_version_changed' };
  }

  const deltaMinor = evaluation.selection.unitItemPrice.amount - line.unitItemPriceAmount;
  return {
    known: true,
    direction: deltaMinor === 0 ? 'unchanged' : deltaMinor < 0 ? 'down' : 'up',
    deltaMinor,
    currency: evaluation.selection.unitItemPrice.currency,
    since: prior.evaluatedAt.toISOString(),
  };
}

/** One quote per distinct conversion, in a stable order. */
function dedupeRates(rates: readonly FxRateSnapshot[]): FxRateSnapshot[] {
  const byKey = new Map<string, FxRateSnapshot>();
  for (const rate of rates) {
    byKey.set(`${rate.from}:${rate.to}:${rate.provider}:${rate.asOf}:${rate.rate}`, rate);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.from}${left.to}${left.asOf}`.localeCompare(`${right.from}${right.to}${right.asOf}`),
  );
}

/**
 * Evaluate one list into a basket.
 *
 * Items are priced in bounded parallel batches rather than all at once: one
 * comparison is one `listOffers` plus one rate resolution, and a 200-item list
 * firing 200 of them together is a self-inflicted load spike on the read path
 * every product page shares. The batches preserve list order because each result
 * is written back at its own index.
 */
export async function evaluateWatchlistBasket(
  input: EvaluateWatchlistInput,
): Promise<WatchlistBasket> {
  const evaluatedAt = input.now ?? new Date();
  const context = await loadCatalogueContext(input.items);

  const outcomes: ItemOutcome[] = new Array(input.items.length);
  const concurrency = Math.max(1, config.watchlists.evaluationConcurrency);
  for (let start = 0; start < input.items.length; start += concurrency) {
    const batch = input.items.slice(start, start + concurrency);
    const settled = await Promise.all(
      batch.map((item) => evaluateOneItem(input.watchlist, item, context)),
    );
    settled.forEach((outcome, offset) => {
      outcomes[start + offset] = outcome;
    });
  }

  const lines: WatchlistBasketLine[] = [];
  const unresolved: WatchlistBasket['unresolved'][number][] = [];
  const pricedLines: WatchlistTotalLine[] = [];
  const rates: FxRateSnapshot[] = [];
  const policyVersions = new Set<string>();

  input.items.forEach((item, index) => {
    const outcome = outcomes[index];
    const projected = input.projected[index];
    if (outcome === undefined || projected === undefined) return;

    if (outcome.policyVersion !== undefined) policyVersions.add(outcome.policyVersion);
    rates.push(...outcome.rates);

    const unitPrice: Money | undefined =
      outcome.evaluation.state === 'priced'
        ? outcome.evaluation.selection.unitItemPrice
        : undefined;

    lines.push({
      item: projected,
      evaluation: outcome.evaluation,
      priceChange: priceChangeFor(
        item.id,
        outcome.evaluation,
        input.watchlist.displayCurrency,
        outcome.policyVersion,
        input.prior,
      ),
      target: resolveWatchlistTarget(projected.target, unitPrice),
    });

    if (outcome.evaluation.state === 'priced') {
      pricedLines.push({
        lineItemPrice: outcome.evaluation.selection.lineItemPrice,
        delivery: outcome.evaluation.selection.delivery,
      });
    } else {
      unresolved.push({
        itemId: item.id,
        canonicalProductId: item.canonicalProductId,
        reason: outcome.evaluation.reason,
      });
    }
  });

  return {
    watchlistId: input.watchlist.id,
    listVersion: input.watchlist.version,
    displayCurrency: input.watchlist.displayCurrency,
    ...(input.watchlist.market === null || input.watchlist.market === undefined
      ? {}
      : { market: input.watchlist.market }),
    rankingPolicyVersions: [...policyVersions].sort(),
    total: composeWatchlistTotal({
      displayCurrency: input.watchlist.displayCurrency,
      pricedLines,
      totalItems: input.items.length,
    }),
    optimization: WATCHLIST_BASKET_OPTIMIZATION_SEAM,
    lines,
    unresolved,
    rates: dedupeRates(rates),
    evaluatedAt: evaluatedAt.toISOString(),
    ...(input.prior === undefined ? {} : { comparedWithSnapshotId: input.prior.id }),
  };
}
