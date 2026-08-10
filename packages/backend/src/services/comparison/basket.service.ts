/**
 * Solving one basket (#96 §"Basket optimization problem").
 *
 * The impure half: gather each line's candidates through #74's ranked
 * comparison, prune them, run the deterministic solver once per requested
 * objective, name the results, split them into transactions and snapshot the
 * whole input.
 *
 * ## Candidates come from #74 and from nowhere else
 *
 * One `rankOfferComparison` per line, in the comparison's ONE currency. That is
 * what makes the eligibility, the conversion, the captured quotes and the
 * tie-break the same ones a product page shows — a basket that read `offers`
 * directly would be a second definition of which offers a shopper may see, and
 * the two would disagree in exactly the window where a jury has restricted a
 * listing.
 *
 * The cost is stated rather than hidden: a forty-line basket is forty ranked
 * reads, which is why {@link MAX_BASKET_LINES} exists and why the route is on
 * the read-path rate limit.
 *
 * ## The rates are resolved ONCE, here
 *
 * #74 converts prices internally and publishes the snapshots, not the rate map,
 * so the one thing a basket needs beyond a ranked offer — the merchant's
 * free-shipping THRESHOLD, converted into the comparison currency — is
 * converted here through the ranking domain's own pure `convertOfferMoney`.
 * Reusing that function rather than writing a second conversion is deliberate:
 * two conversions of one currency pair is two answers to what a threshold is.
 */

import {
  ALL_CURRENCY_CODES,
  CONSTRAINT_EVALUATION_VERSION,
  COMPARISON_POLICY_VERSION,
  NORMALIZATION_RULE_VERSION,
  type BasketObjective,
  type BasketPlanActions,
  type BasketReasonCode,
  type BasketRequest,
  type BasketSolution,
  type ComparisonPolicyIdentity,
  type ComparisonRecordRef,
  type CurrencyCode,
  type Offer,
  type OfferRelationshipStanding,
  type RankedOffer,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { resolveOfferSellers } from '../product-page/sellers.js';
import { rankOfferComparison } from '../ranking/comparison.service.js';
import { composePlanActions } from './basket/actions.js';
import {
  comparisonRates,
  sellerLabelOf,
  toCandidate,
} from './basket/candidate-source.js';
import { pruneBasketCandidates, type BasketCandidate } from './basket/candidates.js';
import { composeBasketResults, type SolvedObjective } from './basket/results.js';
import { buildBasketSnapshot } from './basket/snapshot.js';
import { solveBasket } from './basket/solver.js';
import { MAX_BASKET_LINES } from './policy.js';
import { ComparisonRecordIndex } from './record-refs.js';
import { collectComparisonRates, toMoneyFact } from './render.js';

/** How many offers each line's ranked read asks for. */
const OFFERS_PER_LINE = 25;

export interface SolveBasketRequest {
  readonly request: BasketRequest;
  /** Whether the offers half may be served at all — the controller's lever. */
  readonly offerComparisonPermitted: boolean;
  /**
   * Lines the CALLER already knows cannot be planned, by line id.
   *
   * A #81 watchlist item a catalogue split left pointing at two products is the
   * case this exists for. Such a line is still in `request.lines`, so it counts
   * toward coverage and appears in `unresolved` with its own reason — rather
   * than being dropped, which would make a basket of four items silently plan
   * three and report success.
   *
   * No offers are gathered for it: asking #74 about a product the shopper may
   * not have meant is how the wrong product ends up in a plan.
   */
  readonly callerRefusals?: ReadonlyMap<string, readonly BasketReasonCode[]>;
}

/**
 * Solve a basket and name every alternative.
 *
 * Throws `validationError` only for a request outside the policy bounds. A
 * request nothing can serve is a SOLUTION with unresolved lines and refused
 * results — solver design rule 10 — because "we could not find a plan" is an
 * answer a shopper can act on and a 400 is not.
 */
export async function solveBasketRequest(input: SolveBasketRequest): Promise<BasketSolution> {
  const { request } = input;
  if (request.lines.length === 0) throw validationError('A basket needs at least one line');
  if (request.lines.length > MAX_BASKET_LINES) {
    throw validationError(`A basket holds at most ${String(MAX_BASKET_LINES)} lines`);
  }
  const lineIds = new Set(request.lines.map((line) => line.lineId));
  if (lineIds.size !== request.lines.length) {
    throw validationError('Every basket line needs a distinct lineId');
  }
  if (!(ALL_CURRENCY_CODES as readonly string[]).includes(request.comparisonCurrency)) {
    throw validationError('Unsupported comparison currency');
  }

  const index = new ComparisonRecordIndex();
  const evaluatedAt = new Date().toISOString();
  const callerRefusals = input.callerRefusals ?? new Map<string, readonly BasketReasonCode[]>();
  const gathered = input.offerComparisonPermitted
    ? await gatherCandidates(request, index, callerRefusals)
    : { candidates: [] as BasketCandidate[], rankingPolicyVersion: '' };

  const pruned = pruneBasketCandidates({
    lines: request.lines,
    candidates: gathered.candidates,
    channelPolicy: request.channelPolicy,
    excludedMerchantIds: request.excludedMerchantIds ?? [],
    ...(request.conditionGroups === undefined
      ? {}
      : { conditionGroups: request.conditionGroups }),
  });

  const refusals = new Map<string, readonly BasketReasonCode[]>(pruned.refusals);
  if (!input.offerComparisonPermitted) {
    for (const line of request.lines) refusals.set(line.lineId, ['no_eligible_offer']);
  }
  // LAST, so a caller's own reason survives the offers lever being off: "we
  // cannot tell which product you meant" stays the answer either way, and it is
  // the one the shopper can act on.
  for (const [lineId, reasons] of callerRefusals) refusals.set(lineId, reasons);

  // Every objective the request asked for, PLUS the two the named results are
  // derived from. Asking for them unconditionally is what lets a caller who
  // requested only `fewest_merchants` still be told what the cheapest plan
  // would have cost — a comparison surface that answered only the question it
  // was asked would make the alternative invisible.
  const objectives = new Set<BasketObjective>([
    ...request.objectives,
    'cheapest_known_item_prices',
    'cheapest_known_total',
  ]);

  const solved: SolvedObjective[] = [];
  let consideredMerchantCount = 0;
  for (const objective of [...objectives].sort()) {
    const outcome = solveBasket({
      lines: request.lines,
      candidates: pruned.candidates,
      objective,
      currency: request.comparisonCurrency,
      refusals,
      ...(request.maxMerchants === undefined ? {} : { maxMerchants: request.maxMerchants }),
      candidatesTruncated: pruned.truncated,
    });
    solved.push({ objective, plan: outcome.plan, optimality: outcome.optimality });
    consideredMerchantCount = Math.max(consideredMerchantCount, outcome.consideredMerchantCount);
  }

  const results = composeBasketResults({
    request,
    solved,
    requestedLineCount: request.lines.length,
  });

  const byOfferRef = new Map(pruned.candidates.map((candidate) => [candidate.offerRef, candidate]));
  const actions: Record<string, BasketPlanActions> = {};
  for (const result of results) {
    if (result.state !== 'produced') continue;
    actions[result.kind] = composePlanActions(result.plan, byOfferRef);
  }

  const policy: ComparisonPolicyIdentity = {
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    rankingPolicyVersion: gathered.rankingPolicyVersion,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
  };

  const records: readonly ComparisonRecordRef[] = index.all();
  return {
    snapshot: buildBasketSnapshot({
      policy,
      evaluatedAt,
      request,
      candidates: pruned.candidates,
      rates: collectComparisonRates(
        pruned.candidates.flatMap((candidate) => [candidate.unitItemPrice, candidate.delivery]),
      ),
    }),
    records,
    results,
    actions,
    ...(request.pickupPreference === undefined
      ? {}
      : { pickup: { state: 'unavailable', reason: 'pickup_data_unavailable' } as const }),
    candidateCount: pruned.candidates.length,
    consideredMerchantCount,
  };
}

/** Every line's candidates, from #74's ranked comparison. */
async function gatherCandidates(
  request: BasketRequest,
  index: ComparisonRecordIndex,
  callerRefusals: ReadonlyMap<string, readonly BasketReasonCode[]>,
): Promise<{ candidates: BasketCandidate[]; rankingPolicyVersion: string }> {
  const db = getDb();
  const candidates: BasketCandidate[] = [];
  let rankingPolicyVersion = '';

  // One rate resolution for the whole solve, through the ONE module that
  // resolves them — so the terms this solve is performed against and the terms
  // revalidation re-reads later are computed the same way.
  const rates = await comparisonRates(request.comparisonCurrency);

  for (const line of request.lines) {
    if (callerRefusals.has(line.lineId)) continue;
    const ranked = await rankOfferComparison({
      ...(line.canonicalVariantId === undefined
        ? { canonicalProductId: line.canonicalProductId }
        : { canonicalVariantId: line.canonicalVariantId }),
      comparisonCurrency: request.comparisonCurrency,
      ...(request.market === undefined ? {} : { market: request.market }),
      ...(line.conditionGroups === undefined ? {} : { conditionGroups: line.conditionGroups }),
      limit: OFFERS_PER_LINE,
    });
    rankingPolicyVersion = ranked.comparison.policy.version;

    const offers = ranked.comparison.offers
      .map((rankedOffer) => ranked.offers.get(rankedOffer.offerId))
      .filter((offer): offer is Offer => offer !== undefined);
    const sellers = await resolveOfferSellers(offers, db);

    const subjectRef = index.register({
      kind: 'canonical_product',
      recordId: line.canonicalProductId,
    });

    for (const rankedOffer of ranked.comparison.offers) {
      const offer = ranked.offers.get(rankedOffer.offerId);
      if (offer === undefined) continue;
      candidates.push(
        toCandidate({
          index,
          lineId: line.lineId,
          subjectRef,
          offer,
          rankedOffer,
          policyVersion: ranked.comparison.policy.version,
          currency: request.comparisonCurrency,
          rates,
          sellerLabel: sellerLabelOf(sellers.get(offer.id)),
        }),
      );
    }
  }

  return { candidates, rankingPolicyVersion };
}

