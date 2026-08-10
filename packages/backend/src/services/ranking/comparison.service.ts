/**
 * The offer comparison entry point (#74) — the ONE function a discovery surface
 * calls, and the seam #70's canonical search consumes.
 *
 * Everything above it is pure. This module does the four impure things
 * (read the offers, read the facts, read the rates, read the policy) and then
 * hands values to `selectEligibleOffers` and `rankOffers`, in that order and
 * never the reverse — which is the composition the whole issue turns on.
 *
 * ## Ranking never widens what eligibility admitted, and never narrows it either
 *
 * The eligible set goes to the ranker whole. There is no post-rank filter, no
 * score floor and no "drop anything under N": a score is an ORDER, and dropping
 * an offer for scoring badly would be an eligibility rule nobody wrote down and
 * nobody could explain to the seller whose offer disappeared.
 *
 * ## The comparison names its currency, and this module does not choose it
 *
 * `comparisonCurrency` is REQUIRED. FAIR is Mercaria's display default and that
 * is a product policy stated where the policy lives (`user-preference.service`);
 * a ranking module that reached for it would make the default a ranking fact,
 * and `offer-ranking-isolation.test.ts` fails the build on any FAIR or OxyPay
 * spelling in this domain — the `retail-pricing` device, for the same reason.
 *
 * ## The SQL filter is a PRE-FILTER; eligibility is the authority
 *
 * `listOffers` narrows by scope, market and condition in the database because a
 * million-row table has to be narrowed somewhere, and eligibility then evaluates
 * every rule again over what came back. The two can only disagree by the SQL
 * having been NARROWER, so the derivation can never admit something the query
 * excluded — #68's `stale_at` split, applied to a filter instead of a deadline.
 */

import {
  ALL_CURRENCY_CODES,
  type ConditionGroup,
  type CurrencyCode,
  type ItemConditionKey,
  type Offer,
  type OfferComparisonExperience,
  type OfferComparisonIntent,
  type OfferCustomerEligibility,
  type RankedOfferComparison,
} from '@mercaria/shared-types';
import { getRates } from '../fx.service.js';
import { listOffers } from '../offers/offer.service.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { selectEligibleOffers, type OfferEligibilityContext } from './eligibility.js';
import { buildOfferRankingFacts, buildRankingFactContext, dominanceSubjectFor } from './facts.js';
import { collectRateSnapshots } from './money.js';
import { detectRankingDominance, type DominanceSubject } from './dominance.js';
import { rankOffers } from './ranking.js';
import { resolveNamedRankingPolicy, resolveRankingPolicy } from './policy.service.js';

/** What a caller asks for. Exactly one scope, exactly one currency. */
export interface OfferComparisonRequest {
  readonly canonicalVariantId?: string;
  readonly canonicalProductId?: string;
  /** REQUIRED — see the module docblock. */
  readonly comparisonCurrency: CurrencyCode;
  readonly intent?: OfferComparisonIntent;
  readonly experience?: OfferComparisonExperience;
  /** The shopper's market, ISO 3166-1 alpha-2. */
  readonly market?: string;
  readonly customerClasses?: readonly OfferCustomerEligibility[];
  readonly conditionKeys?: readonly ItemConditionKey[];
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly viewerLatitude?: number;
  readonly viewerLongitude?: number;
  readonly limit: number;
  /**
   * Run under ONE named policy version instead of the rollout's.
   *
   * The operator surface's parameter and nothing else's: a public caller able to
   * name a version could shop for whichever ordering suited them, and the
   * comparison a shopper is shown must be the one the rollout decided.
   */
  readonly policyVersion?: string;
  /**
   * Include offers a freshness contract has already retired, so the exclusion
   * list is COMPLETE.
   *
   * Operator-only. On the public path an expired offer is dropped by the SQL
   * pre-filter, which is what stops a stale catalogue filling a shopper's page
   * budget with rows nothing will show; on a trace, "why is my offer missing"
   * cannot be answered by a list that already dropped it.
   */
  readonly diagnostic?: boolean;
}

/** The comparison, plus the offers behind it for a caller that needs the DTOs. */
export interface OfferComparisonResult {
  readonly comparison: RankedOfferComparison;
  /** Every offer considered, by id — including the ones eligibility refused. */
  readonly offers: ReadonlyMap<string, Offer>;
}

/**
 * The rollout's policy, or the one an operator named.
 *
 * A named version that does not exist is a 400 rather than a silent fall back to
 * the rollout's: an operator comparing two versions must be told the one they
 * asked for is missing, not handed a diff between the active policy and itself.
 */
async function resolveComparisonPolicy(subjectKey: string, policyVersion: string | undefined) {
  if (policyVersion === undefined) return resolveRankingPolicy(subjectKey);
  const named = await resolveNamedRankingPolicy(policyVersion);
  if (named === null) throw validationError(`Unknown ranking policy version ${policyVersion}`);
  return named;
}

/**
 * Rank one product's or one variant's offers.
 *
 * The order of operations is load-bearing and is the issue's own: fetch, build
 * facts, ADMIT, then score. Scoring before admitting would be the collapsed
 * design this whole domain exists to avoid.
 */
export async function rankOfferComparison(
  request: OfferComparisonRequest,
): Promise<OfferComparisonResult> {
  if ((request.canonicalVariantId ? 1 : 0) + (request.canonicalProductId ? 1 : 0) !== 1) {
    throw validationError('Provide exactly one of canonicalVariantId or canonicalProductId');
  }
  if (!(ALL_CURRENCY_CODES as readonly string[]).includes(request.comparisonCurrency)) {
    throw validationError('Unsupported comparison currency');
  }

  const page = await listOffers({
    ...(request.canonicalVariantId ? { canonicalVariantId: request.canonicalVariantId } : {}),
    ...(request.canonicalProductId ? { canonicalProductId: request.canonicalProductId } : {}),
    ...(request.market ? { country: request.market.toUpperCase() } : {}),
    ...(request.conditionKeys ? { conditions: request.conditionKeys } : {}),
    ...(request.conditionGroups ? { conditionGroups: request.conditionGroups } : {}),
    includeStale: request.diagnostic === true,
    limit: request.limit,
  });

  const offers = new Map(page.offers.map((offer) => [offer.id, offer]));

  // One rate resolution for the whole page, over the distinct currencies present.
  // `getRates` never throws and omits a pair it cannot serve, so an offer in an
  // unquotable currency becomes an UNKNOWN price rather than a failed request.
  const quotes = [
    ...new Set(
      page.offers.flatMap((offer) => {
        const currencies = [offer.price?.currency, offer.delivery.known ? offer.delivery.cost.currency : undefined];
        return currencies.filter((currency): currency is string => currency !== undefined);
      }),
    ),
  ].filter((currency): currency is CurrencyCode =>
    (ALL_CURRENCY_CODES as readonly string[]).includes(currency),
  );
  const rates = await getRates(request.comparisonCurrency, quotes);

  const factContext = await buildRankingFactContext({
    offers: page.offers,
    comparisonCurrency: request.comparisonCurrency,
    rates,
    ...(request.market === undefined ? {} : { market: request.market }),
    ...(request.viewerLatitude === undefined ? {} : { viewerLatitude: request.viewerLatitude }),
    ...(request.viewerLongitude === undefined ? {} : { viewerLongitude: request.viewerLongitude }),
  });

  const eligibilityContext: OfferEligibilityContext = {
    canonicalVariantIds: new Set(page.offers.map((offer) => offer.canonicalVariantId)),
    ...(request.market === undefined ? {} : { market: request.market.toUpperCase() }),
    customerClasses: request.customerClasses ?? [],
    experience: request.experience ?? 'buy_now',
    ...(request.conditionKeys === undefined ? {} : { conditionKeys: request.conditionKeys }),
    ...(request.conditionGroups === undefined ? {} : { conditionGroups: request.conditionGroups }),
    suppressedMerchantIds: factContext.suppressedMerchantIds,
    suppressedStorefrontIds: factContext.suppressedStorefrontIds,
  };

  const selection = selectEligibleOffers({
    offers: page.offers,
    context: eligibilityContext,
    buildFacts: (offer) => buildOfferRankingFacts(offer, factContext),
  });

  // The rollout is keyed on the comparison SUBJECT, so one product always sees
  // one arm and a shopper does not watch the order flip between refreshes.
  const subjectKey = request.canonicalProductId ?? request.canonicalVariantId ?? '';
  const policy = await resolveComparisonPolicy(subjectKey, request.policyVersion);

  const intent = request.intent ?? 'balanced';
  const ranked = rankOffers({
    candidates: selection.eligible,
    policy,
    intent,
    viewerLocationProvided:
      request.viewerLatitude !== undefined && request.viewerLongitude !== undefined,
  });

  const subjects = new Map<string, DominanceSubject>();
  for (const admitted of selection.eligible) {
    const offer = offers.get(admitted.offerId);
    if (offer === undefined) continue;
    subjects.set(admitted.offerId, dominanceSubjectFor(offer, factContext));
  }

  return {
    comparison: {
      policy,
      intent,
      experience: eligibilityContext.experience,
      comparisonCurrency: request.comparisonCurrency,
      rates: collectRateSnapshots(
        selection.eligible.flatMap((admitted) => [
          admitted.facts.itemPrice,
          admitted.facts.deliveryCost,
        ]),
      ),
      offers: ranked,
      excluded: selection.excluded.map((verdict) => ({
        offerId: verdict.offerId,
        reasons: verdict.reasons,
      })),
      dominance: detectRankingDominance({ ranked, subjects, policy }),
    },
    offers,
  };
}
