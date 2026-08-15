/**
 * The deterministic evaluation (#97 §"Evaluation pipeline", rules 3–6).
 *
 * This module is the whole of what decides whether a saved objective is met,
 * and every fact it reads comes from a domain that already owns it: #94
 * validates and evaluates the constraints, #74 decides which offers may be seen
 * and in what order, #96 solves the plan and hashes everything it read. Nothing
 * here ranks, prices, converts a currency or judges an offer.
 *
 * ## Why the whole domain rests on ONE solver call
 *
 * All six launch jobs are questions about the SAME object — the best plan for
 * this shopper's lines under their constraints, right now — asked from six
 * directions. #96 already answers every one of them as a NAMED RESULT:
 * `cheapest_known_total`, `used_or_refurbished_value`, `official_channel_plan`
 * and the rest, each either `produced` with a plan or `refused` with reason
 * codes. So the deterministic half of #97 is a translation of an agent into a
 * `BasketRequest` and a read of the result its kind names — not a second
 * comparison engine that could disagree with the product page.
 *
 * The consequence worth stating: #97 acceptance 4 ("no model output can create
 * a product, offer, price, constraint result or transaction") is not enforced
 * here, because there is no model here to enforce it against. A summary is
 * composed from a finding this module has already committed
 * (`summary.service.ts`), and it is the CALL GRAPH that makes it impossible for
 * one to influence a verdict.
 *
 * ## The input digest, and why the finding key rests on it
 *
 * `BasketInputSnapshot.digest` is a sha-256 over the request, the policy
 * versions, every candidate offer with its price and delivery terms, and every
 * FX rate. That is exactly "the version of everything this evaluation read" —
 * #79's `observed_price_version` one layer up. An unchanged catalogue therefore
 * produces an identical digest and the finding converges; a price that moved
 * produces a different one and a new finding is appended. No clock enters it.
 *
 * ## A hard constraint is applied by REFUSING the line, never by relaxing it
 *
 * A line whose product fails a hard constraint is passed to the solver as a
 * `callerRefusal` with #96's own `hard_constraint_failed` code — the seam #96
 * built for #81's unresolved watchlist items. So the line still counts toward
 * coverage and still appears in `unresolved` with its reason, rather than being
 * dropped, which would make an agent watching four things silently watch three.
 */

import {
  CONSTRAINT_EVALUATION_VERSION,
  COMPARISON_POLICY_VERSION,
  NORMALIZATION_RULE_VERSION,
  SHOPPING_AGENT_OFFERS_PER_LINE,
  SHOPPING_AGENT_POLICY_VERSION,
  hasKnownComparisonMoney,
  type BasketObjective,
  type BasketReasonCode,
  type BasketRequest,
  type BasketRequestLine,
  type BasketResult,
  type BasketResultKind,
  type BasketResultPlan,
  type BasketSolution,
  type ConditionGroup,
  type ConstraintSet,
  type CurrencyCode,
  type Money,
  type ShoppingAgentChannelPolicy,
  type ShoppingAgentEvidenceCompleteness,
  type ShoppingAgentFindingOutcome,
  type ShoppingAgentFreshness,
  type ShoppingAgentIncompleteReason,
  type ShoppingAgentJobKind,
  type ShoppingAgentOptimality,
  type ShoppingAgentPriceBasis,
  type ShoppingAgentRecordRef,
  type ShoppingAgentSelectedLine,
  type ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { createHash } from 'node:crypto';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { evaluateCandidate } from '../attributes/constraint-evaluation.js';
import { validateConstraintSet } from '../attributes/constraint-validation.js';
import { loadCandidateFacts, offerContextFor } from '../attributes/entity-facts.service.js';
import { solveBasketRequest } from '../comparison/basket.service.js';

/** One line of the agent, as the evaluator reads it. */
export interface AgentEvaluationLine {
  readonly id: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string;
  readonly quantity: number;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly merchantId?: string;
}

/** Everything an evaluation is handed, and nothing it is not. */
export interface AgentEvaluationSubject {
  readonly id: string;
  readonly kind: ShoppingAgentJobKind;
  readonly displayCurrency: CurrencyCode;
  readonly priceBasis: ShoppingAgentPriceBasis;
  readonly channelPolicy: ShoppingAgentChannelPolicy;
  readonly market?: string;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly excludedMerchantIds: readonly string[];
  readonly targetAmountMinor?: number;
  readonly targetCurrency?: CurrencyCode;
  readonly constraintSet: ConstraintSet;
  readonly lines: readonly AgentEvaluationLine[];
}

/** The prior comparable observation, for the two kinds that need one. */
export interface AgentPriorObservation {
  readonly objectiveAmountMinor: number;
  readonly objectiveCurrency: CurrencyCode;
}

export interface EvaluateAgentInput {
  readonly subject: AgentEvaluationSubject;
  /** #96's own lever, resolved by the CALLER — a service reading it would be a
   * second place the rollout is decided. `readCanonicalProductPage`'s rule. */
  readonly offerComparisonPermitted: boolean;
  readonly prior?: AgentPriorObservation;
  readonly db?: DatabaseOrTransaction;
}

/** What one deterministic pass concluded. */
export interface DeterministicAgentEvaluation {
  readonly outcome: ShoppingAgentFindingOutcome;
  readonly incompleteReasons: readonly ShoppingAgentIncompleteReason[];
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly freshness: ShoppingAgentFreshness;
  readonly optimality?: ShoppingAgentOptimality;
  readonly inputDigest: string;
  readonly rankingPolicyVersion: string;
  readonly comparisonPolicyVersion: string;
  readonly constraintEvaluationVersion: string;
  readonly normalizationRuleVersion: string;
  readonly agentPolicyVersion: string;
  readonly objectiveValue?: Money;
  readonly objectiveDeltaMinor?: number;
  readonly satisfiedConstraintIds: readonly string[];
  readonly failedConstraintIds: readonly string[];
  readonly unknownConstraintIds: readonly string[];
  readonly records: readonly ShoppingAgentRecordRef[];
  readonly selection: readonly ShoppingAgentSelectedLine[];
}

/** Which #96 named result answers each of the six jobs. */
const RESULT_KIND_FOR_JOB: Readonly<Record<ShoppingAgentJobKind, BasketResultKind>> = Object.freeze({
  offer_price_threshold: 'cheapest_known_item_prices',
  used_or_refurbished_appearance: 'used_or_refurbished_value',
  official_channel_availability: 'official_channel_plan',
  basket_target_total: 'cheapest_known_total',
  materially_better_plan: 'cheapest_known_total',
  constraint_satisfiable: 'cheapest_known_item_prices',
});

/**
 * Evaluate one saved objective, deterministically.
 *
 * Never throws for a catalogue it could not read: an evaluation nothing can
 * answer is an `incomplete` FINDING with named reasons, because "we could not
 * tell" is something a shopper can act on and an exception is not. It DOES
 * throw for an infrastructure failure, which the dispatcher turns into a
 * retryable release — the two are different and collapsing them would bury a
 * broken database as a permanent "we could not tell".
 */
export async function evaluateAgentDeterministically(
  input: EvaluateAgentInput,
): Promise<DeterministicAgentEvaluation> {
  const { subject } = input;
  const db = input.db ?? getDb();

  // ── #94: the stored constraints, re-validated against the LIVE registry ──
  //
  // Re-validated on every pass and never trusted as stored: a definition
  // retired since the agent was saved must refuse the evaluation rather than be
  // read under whatever the key means now. #97 evaluation 3's "revalidate
  // entity, offer and relationship state at evaluation time", applied to the
  // one input that is a stored document.
  const validation = await validateConstraintSet(db, subject.constraintSet);
  if (validation.valid !== true) {
    return incomplete(subject, ['constraint_set_invalid']);
  }

  const constraintOutcomes = await evaluateLineConstraints(subject, validation.set);
  if (constraintOutcomes.state === 'unavailable') {
    return incomplete(subject, ['constraint_facts_unavailable']);
  }

  // ── #96: one solve, over the lines the constraints admit ─────────────────
  const solution = await solveBasketRequest({
    request: basketRequestFor(subject),
    offerComparisonPermitted: input.offerComparisonPermitted,
    callerRefusals: constraintOutcomes.refusals,
  });

  const records = solution.records.map((record) => ({
    ref: record.ref,
    kind: record.kind,
    recordId: record.recordId,
    ...(record.canonicalPath === undefined ? {} : { canonicalPath: record.canonicalPath }),
    ...(record.label === undefined ? {} : { label: record.label }),
  }));

  const base = {
    inputDigest: solution.snapshot.digest,
    rankingPolicyVersion: solution.snapshot.policy.rankingPolicyVersion,
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
    agentPolicyVersion: SHOPPING_AGENT_POLICY_VERSION,
    satisfiedConstraintIds: constraintOutcomes.satisfied,
    failedConstraintIds: constraintOutcomes.failed,
    unknownConstraintIds: constraintOutcomes.unknown,
    records,
  } as const;

  const named = solution.results.find(
    (result) => result.kind === RESULT_KIND_FOR_JOB[subject.kind],
  );
  if (named === undefined || named.state !== 'produced') {
    // #96 already names WHY a result could not be produced, in its own closed
    // vocabulary. Translating rather than re-deciding is what keeps one answer
    // to "why is there no plan" between a product page and an agent.
    return {
      ...base,
      outcome: 'incomplete',
      incompleteReasons: translateReasons(named?.reasons ?? ['no_eligible_offer']),
      completeness: 'partial',
      freshness: 'unknown',
      selection: [],
    };
  }

  const selection = selectionOf(named, solution);
  const freshness = named.plan.freshness;
  const optimality: ShoppingAgentOptimality =
    named.optimality.status === 'proven_optimal' ? 'proven_optimal' : 'approximate';

  // A plan that did not cover every line cannot answer a question about the
  // whole objective. #97 acceptance 5 for the total kinds, and the same truth
  // for the others: "a used one appeared" is a claim about a line that was
  // actually served.
  if (named.plan.unresolved.length > 0) {
    return {
      ...base,
      outcome: 'incomplete',
      incompleteReasons: uniqueReasons([
        'basket_partially_covered',
        ...translateReasons(named.plan.unresolved.flatMap((line) => line.reasons)),
      ]),
      completeness: 'partial',
      freshness,
      optimality,
      selection,
    };
  }

  const measured = objectiveOf(subject, named);
  if (measured.state === 'unknown') {
    return {
      ...base,
      outcome: 'incomplete',
      incompleteReasons: measured.reasons,
      completeness: 'partial',
      freshness,
      optimality,
      selection,
    };
  }

  const verdict = decide(subject, measured.amount, input.prior);
  if (verdict.state === 'incomplete') {
    return {
      ...base,
      outcome: 'incomplete',
      incompleteReasons: verdict.reasons,
      completeness: 'partial',
      freshness,
      optimality,
      selection,
    };
  }

  if (verdict.state === 'not_qualified') {
    return {
      ...base,
      outcome: 'not_qualified',
      incompleteReasons: [],
      completeness: 'complete',
      freshness,
      optimality,
      selection,
    };
  }

  return {
    ...base,
    outcome: 'qualified',
    incompleteReasons: [],
    completeness: 'complete',
    freshness,
    optimality,
    objectiveValue: measured.amount,
    ...(verdict.deltaMinor === undefined ? {} : { objectiveDeltaMinor: verdict.deltaMinor }),
    selection,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The agent as a `BasketRequest`.
 *
 * Every objective the agent's kind could need is requested, PLUS #96's own two
 * derived ones — so a `fewest_merchants` question can still be told what the
 * cheapest plan would have cost. The translation is field-for-field with no
 * reinterpretation, which is why the two vocabularies were made to match rather
 * than mapped.
 */
function basketRequestFor(subject: AgentEvaluationSubject): BasketRequest {
  const lines: BasketRequestLine[] = subject.lines.map((line) => ({
    lineId: line.id,
    canonicalProductId: line.canonicalProductId,
    ...(line.canonicalVariantId === undefined
      ? {}
      : { canonicalVariantId: line.canonicalVariantId }),
    quantity: line.quantity,
    ...(line.conditionGroups.length === 0 ? {} : { conditionGroups: line.conditionGroups }),
    ...(line.merchantId === undefined ? {} : { merchantId: line.merchantId }),
  }));

  const objectives: BasketObjective[] =
    subject.priceBasis === 'delivered_total'
      ? ['cheapest_known_total']
      : ['cheapest_known_item_prices'];

  return {
    lines,
    comparisonCurrency: subject.displayCurrency,
    channelPolicy: subject.channelPolicy,
    ...(subject.market === undefined ? {} : { market: subject.market }),
    ...(subject.conditionGroups.length === 0
      ? {}
      : { conditionGroups: subject.conditionGroups }),
    objectives,
    ...(subject.excludedMerchantIds.length === 0
      ? {}
      : { excludedMerchantIds: subject.excludedMerchantIds }),
  };
}

interface LineConstraintOutcomes {
  readonly state: 'evaluated';
  readonly refusals: ReadonlyMap<string, readonly BasketReasonCode[]>;
  readonly satisfied: readonly string[];
  readonly failed: readonly string[];
  readonly unknown: readonly string[];
}

/**
 * #94's verdict for every line, and the refusals the solver is handed.
 *
 * The aggregate across lines is deliberately CONSERVATIVE and follows
 * `deriveRetailCompleteness`'s severity rule: a constraint appears in `failed`
 * if any line failed it, in `unknown` if any line answered unknown, and in
 * `satisfied` only when every evaluated line satisfied it. Reporting the
 * optimistic union would tell a shopper their requirement was met when it was
 * met by one item of four.
 */
async function evaluateLineConstraints(
  subject: AgentEvaluationSubject,
  set: ValidatedConstraintSet,
): Promise<LineConstraintOutcomes | { readonly state: 'unavailable' }> {
  const refusals = new Map<string, readonly BasketReasonCode[]>();
  const satisfied = new Set<string>();
  const failed = new Set<string>();
  const unknown = new Set<string>();
  // Only a constraint every evaluated line satisfied may be reported satisfied.
  const satisfiedCounts = new Map<string, number>();
  let evaluatedLines = 0;

  const hasConstraints = set.hard.length > 0 || set.preferences.length > 0;

  for (const line of subject.lines) {
    if (!hasConstraints) continue;
    const facts = await loadCandidateFacts(line.canonicalProductId, {
      offerContext: offerContextFor(subject.displayCurrency, subject.market),
    });
    if (facts === undefined) return { state: 'unavailable' };

    const evaluation = evaluateCandidate(
      set,
      facts,
      line.canonicalVariantId === undefined ? {} : { variantId: line.canonicalVariantId },
    );
    evaluatedLines += 1;

    for (const outcome of [...evaluation.hardOutcomes, ...evaluation.preferenceOutcomes]) {
      if (outcome.satisfaction === 'failed') failed.add(outcome.constraintId);
      else if (outcome.satisfaction === 'unknown') unknown.add(outcome.constraintId);
      else satisfiedCounts.set(outcome.constraintId, (satisfiedCounts.get(outcome.constraintId) ?? 0) + 1);
    }

    if (evaluation.verdict === 'excluded') {
      refusals.set(line.id, ['hard_constraint_failed']);
    }
  }

  for (const [constraintId, count] of satisfiedCounts) {
    if (count === evaluatedLines && !failed.has(constraintId) && !unknown.has(constraintId)) {
      satisfied.add(constraintId);
    } else if (!failed.has(constraintId)) {
      unknown.add(constraintId);
    }
  }

  return {
    state: 'evaluated',
    refusals,
    satisfied: [...satisfied].sort(),
    failed: [...failed].sort(),
    unknown: [...unknown].sort(),
  };
}

type MeasuredObjective =
  | { readonly state: 'known'; readonly amount: Money }
  | { readonly state: 'unknown'; readonly reasons: readonly ShoppingAgentIncompleteReason[] };

/**
 * The number this agent's objective is measured in.
 *
 * `delivered_total` reads #96's `deliveredTotal` and `item_price` its
 * `itemSubtotal`, and BOTH are `BasketTotal` — whose unknown branch has no
 * amount at all. So "unknown shipping cannot satisfy a known-total objective"
 * (#97 acceptance 5) is a property of the type: there is no value to compare,
 * not a value that had to be guarded against.
 */
function objectiveOf(
  subject: AgentEvaluationSubject,
  result: BasketResultPlan,
): MeasuredObjective {
  const total =
    subject.priceBasis === 'delivered_total' ? result.plan.deliveredTotal : result.plan.itemSubtotal;
  if (total.state === 'known') return { state: 'known', amount: total.amount };
  return {
    state: 'unknown',
    reasons: uniqueReasons(
      total.missing.map((component) =>
        component === 'item_price' ? 'price_not_convertible' : 'delivery_cost_unknown',
      ),
    ),
  };
}

type Verdict =
  | { readonly state: 'qualified'; readonly deltaMinor?: number }
  | { readonly state: 'not_qualified' }
  | { readonly state: 'incomplete'; readonly reasons: readonly ShoppingAgentIncompleteReason[] };

/**
 * The kind-specific question, asked of a plan that already exists.
 *
 * Four of the six qualify on the plan having been PRODUCED at all — #96's named
 * results are already "the cheapest used plan" and "a plan drawn only from
 * verified official channels", and there is nothing further to decide. The two
 * that compare against a number do exactly that, in one currency, having
 * already refused a total that is not known.
 */
function decide(
  subject: AgentEvaluationSubject,
  amount: Money,
  prior: AgentPriorObservation | undefined,
): Verdict {
  switch (subject.kind) {
    case 'offer_price_threshold':
    case 'basket_target_total': {
      const targetMinor = subject.targetAmountMinor;
      const targetCurrency = subject.targetCurrency;
      if (targetMinor === undefined || targetCurrency === undefined) {
        // Unreachable while `shopping_agents_target_shape_check` stands; kept
        // because a verdict function that cannot be called wrongly is better
        // than one that trusts a CHECK it cannot see.
        return { state: 'incomplete', reasons: ['constraint_set_invalid'] };
      }
      if (amount.currency !== targetCurrency) {
        return { state: 'incomplete', reasons: ['price_not_convertible'] };
      }
      if (amount.amount > targetMinor) return { state: 'not_qualified' };
      return {
        state: 'qualified',
        ...(prior === undefined || prior.objectiveCurrency !== amount.currency
          ? {}
          : { deltaMinor: amount.amount - prior.objectiveAmountMinor }),
      };
    }
    case 'materially_better_plan': {
      if (prior === undefined) {
        // The FIRST evaluation of a "tell me when it gets better" agent has
        // nothing to be better than. Reporting `not_qualified` would say the
        // plan did not improve, which is a claim; reporting `incomplete` with
        // this reason says what is true — and the finding it writes becomes the
        // baseline the next one compares against.
        return { state: 'incomplete', reasons: ['no_comparable_prior_finding'] };
      }
      if (prior.objectiveCurrency !== amount.currency) {
        return { state: 'incomplete', reasons: ['price_not_convertible'] };
      }
      const deltaMinor = amount.amount - prior.objectiveAmountMinor;
      if (amount.amount > materialCeiling(prior.objectiveAmountMinor)) {
        return { state: 'not_qualified' };
      }
      return { state: 'qualified', deltaMinor };
    }
    case 'used_or_refurbished_appearance':
    case 'official_channel_availability':
    case 'constraint_satisfiable':
      return {
        state: 'qualified',
        ...(prior === undefined || prior.objectiveCurrency !== amount.currency
          ? {}
          : { deltaMinor: amount.amount - prior.objectiveAmountMinor }),
      };
  }
}

/** #79's material-improvement ceiling, so the two domains agree on "better". */
function materialCeiling(previousMinor: number): number {
  const proportional = Math.floor((previousMinor * 9_900) / 10_000);
  return Math.min(proportional, previousMinor - 1);
}

/** #96's plan lines, as the finding stores them. */
function selectionOf(
  result: BasketResultPlan,
  solution: BasketSolution,
): readonly ShoppingAgentSelectedLine[] {
  const merchantByRef = new Map(
    result.plan.merchants.flatMap((merchant) =>
      merchant.lineIds.map((lineId) => [lineId, merchant] as const),
    ),
  );
  const subjectByRef = new Map(solution.records.map((record) => [record.ref, record] as const));

  return result.plan.lines.map((line) => {
    const merchant = merchantByRef.get(line.lineId);
    const unit = hasKnownComparisonMoney(line.unitItemPrice) ? line.unitItemPrice.amount : undefined;
    return {
      lineId: line.lineId,
      canonicalProductId: subjectByRef.get(line.subjectRef)?.recordId ?? line.subjectRef,
      offerRef: line.offerRef,
      quantity: line.quantity,
      ...(unit === undefined ? {} : { unitItemPrice: unit }),
      ...(line.conditionGroup === undefined ? {} : { conditionGroup: line.conditionGroup }),
      nativeCheckoutEligible:
        (merchant?.channel ?? line.channel) === 'native_checkout',
      // #55's verified standing, as #74 awarded it. `authorized_reseller` is
      // deliberately NOT official (#55 keeps the two badges separate and #71
      // splits them into two groups), so an official-channel agent is never
      // satisfied by a reseller.
      officialChannel: line.relationship === 'official_channel',
    };
  });
}

/** #96's reason codes, narrowed to the ones an agent's owner can act on. */
function translateReasons(
  reasons: readonly BasketReasonCode[],
): readonly ShoppingAgentIncompleteReason[] {
  const mapped = reasons.map<ShoppingAgentIncompleteReason>((reason) => {
    switch (reason) {
      case 'no_convertible_price':
        return 'price_not_convertible';
      case 'delivery_cost_unknown':
      case 'tax_inclusion_unknown':
      case 'objective_requires_complete_costs':
        return 'delivery_cost_unknown';
      default:
        // Everything else is some flavour of "nothing in scope served this
        // line". They are deliberately NOT unpacked one-to-one: #96's set is
        // about a basket a shopper is looking at, and an agent's owner acts on
        // the same remedy for all of them — widen the scope or wait.
        return 'no_eligible_offer';
    }
  });
  return uniqueReasons(mapped);
}

function uniqueReasons(
  reasons: readonly ShoppingAgentIncompleteReason[],
): readonly ShoppingAgentIncompleteReason[] {
  return [...new Set(reasons)].sort();
}

/**
 * An evaluation that never reached the solver.
 *
 * The digest is derived from the agent and the REASON rather than left NULL or
 * randomised, so a repeated failure of the same kind converges on one finding
 * instead of appending an identical row on every sweep — the unique index does
 * the deduplication, exactly as it does for a successful pass.
 */
function incomplete(
  subject: AgentEvaluationSubject,
  reasons: readonly ShoppingAgentIncompleteReason[],
): DeterministicAgentEvaluation {
  return {
    outcome: 'incomplete',
    incompleteReasons: uniqueReasons(reasons),
    completeness: 'partial',
    freshness: 'unknown',
    inputDigest: `unsolved:${createHash('sha256')
      .update(`${subject.id}|${[...reasons].sort().join(',')}`)
      .digest('hex')}`,
    rankingPolicyVersion: '',
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
    agentPolicyVersion: SHOPPING_AGENT_POLICY_VERSION,
    satisfiedConstraintIds: [],
    failedConstraintIds: [],
    unknownConstraintIds: [],
    records: [],
    selection: [],
  };
}

/** Exported for the offers-per-line bound the solver is asked for. */
export const AGENT_OFFERS_PER_LINE = SHOPPING_AGENT_OFFERS_PER_LINE;

/** Whether a result was produced at all — narrowing helper for the tests. */
export function producedResult(result: BasketResult | undefined): result is BasketResultPlan {
  return result !== undefined && result.state === 'produced';
}
