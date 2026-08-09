/**
 * The decision policy: pure, versioned, and the only place an outcome is chosen
 * (#58 pipeline 7–8).
 *
 * Nothing here reads a database, a clock or a request. A policy plus a set of
 * scored candidates determines an outcome completely, which is what makes
 * "outcomes can be compared across policy versions" (#58 operations 2) a
 * property rather than a hope: two decisions carrying the same
 * `policy_version_id` were produced by exactly this function over exactly these
 * thresholds, and the thresholds are still readable because
 * `match_policy_versions` refuses to let them change.
 *
 * ## Confidence is a weighted mean over the features that HAVE a value
 *
 * `Σ(wᶠ · vᶠ) / Σ(wᶠ)` for every feature whose value is not NULL. The
 * denominator moving is the whole trick, and it is #58 rule 5 —
 * "missing attributes reduce confidence rather than being invented" — expressed
 * as arithmetic rather than as a penalty somebody has to remember to apply:
 *
 * - Treating a missing feature as **zero** would assert a disagreement nobody
 *   observed. A listing that declares no brand would score as though its brand
 *   were wrong, and P2P listings — which declare almost nothing — would never
 *   match anything.
 * - Treating it as the **mean of the others** would let a candidate with one
 *   strong feature and six unknowns reach the same score as one with seven
 *   strong features. That is invention.
 *
 * Leaving it out does neither: a subject with fewer observed features simply has
 * fewer things agreeing, so it takes a stronger agreement on what IS known to
 * reach the same number, and the missing feature is visible as a NULL on the
 * stored candidate row for anyone reviewing it.
 *
 * ## Why some stages are gated by the category benchmark and some are not
 *
 * `GATED_MATCH_STAGES` is a data table because the distinction is a real one and
 * a reader deserves to see it stated rather than inferred from an `if`.
 *
 * An identifier match (stages 1–3) is not this pipeline's judgement. A GTIN's
 * check digit either validates or it does not, and `product_identifiers` has at
 * most one ACTIVE owner per canonical value by partial unique index — so the
 * pipeline's entire contribution is validation and a lookup, neither of which
 * has an error rate a labelled benchmark could measure. Gating it would mean a
 * fresh deployment could not attach a single barcode-bearing listing until
 * somebody ran a benchmark measuring the accuracy of… arithmetic.
 *
 * Stages 4, 5 and 6 ARE this pipeline's judgement — a normalized name can
 * collide, a title can mislead, a semantic score can be confidently wrong — so
 * those are exactly the stages whose precision a benchmark measures and exactly
 * the ones a category gate governs.
 */

import {
  DETERMINISTIC_MATCH_FEATURES,
  type MatchBlocker,
  type MatchFeatureName,
  type MatchOutcome,
  type MatchReasonCode,
  type MatchStage,
} from '@mercaria/shared-types';

/** The thresholds and weights of one policy version, as the scorer reads them. */
export interface MatchPolicy {
  readonly id: string;
  readonly versionKey: string;
  readonly autoMinConfidence: number;
  readonly reviewMinConfidence: number;
  readonly minCandidateSeparation: number;
  readonly maxCandidates: number;
  readonly minTitleSimilarity: number;
  readonly weights: Readonly<Record<MatchFeatureName, number>>;
  readonly semanticEnabled: boolean;
  readonly minBenchmarkPrecision: number;
  readonly minBenchmarkSamples: number;
}

/**
 * The stages whose automatic outcome a category gate governs.
 *
 * Stated as a set, not as a condition, so adding a stage forces a decision about
 * which half of the line it falls on. See the module note for why the identifier
 * stages are not here.
 */
export const GATED_MATCH_STAGES: readonly MatchStage[] = [
  'normalized_attributes',
  'candidate_retrieval',
  'semantic_assist',
];

/** One candidate's feature values. A missing key is UNKNOWN, never zero. */
export type MatchFeatureValues = Partial<Record<MatchFeatureName, number>>;

/** A candidate after scoring, before the policy has chosen anything. */
export interface ScoredCandidate {
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly features: MatchFeatureValues;
  /** Facts about THIS candidate that forbid merging into it. */
  readonly blockers: readonly MatchBlocker[];
  /** Why this candidate is out of the running entirely, when it is. */
  readonly rejection: MatchBlocker | null;
  readonly score: number;
}

/** What the policy decided, and everything needed to explain it. */
export interface PolicyDecision {
  readonly outcome: MatchOutcome;
  /** NULL for a deterministic stage — certainty by construction outranks a number. */
  readonly confidence: number | null;
  readonly blockers: readonly MatchBlocker[];
  readonly reasonCodes: readonly MatchReasonCode[];
  readonly selected: ScoredCandidate | null;
}

/**
 * The weighted mean over the features that have a value.
 *
 * @returns The confidence in `[0, 1]`, or `null` when NO feature had a value at
 *   all — which is a real state (a bare title against a bare canonical name with
 *   every weight on features nobody observed) and is not the same as a
 *   confidence of zero.
 */
export function computeConfidence(
  features: MatchFeatureValues,
  weights: Readonly<Record<MatchFeatureName, number>>,
): number | null {
  let weighted = 0;
  let total = 0;
  for (const name of Object.keys(weights) as MatchFeatureName[]) {
    const value = features[name];
    if (value === undefined || value === null) continue;
    const weight = weights[name];
    if (weight <= 0) continue;
    weighted += weight * value;
    total += weight;
  }
  if (total === 0) return null;
  const confidence = weighted / total;
  // Floating-point arithmetic over weights can land a hair outside [0, 1]; the
  // column's CHECK is not a place to discover that.
  return Math.min(1, Math.max(0, confidence));
}

/**
 * Does this candidate have any DETERMINISTIC support at all?
 *
 * The mechanical form of "semantic scoring is one feature, never the sole
 * authority" (#58 pipeline 6, acceptance 6) — and it covers title similarity
 * too, which is the more common way a matcher talks itself into a bad merge. A
 * candidate that agrees on nothing but words is a candidate a person should look
 * at.
 */
export function hasDeterministicSupport(features: MatchFeatureValues): boolean {
  for (const name of DETERMINISTIC_MATCH_FEATURES) {
    const value = features[name];
    if (value !== undefined && value !== null && value > 0) return true;
  }
  return false;
}

/** Whether a stage's confidence is stored as NULL — see the column's CHECK. */
export function isDeterministicStage(stage: MatchStage): boolean {
  return (
    stage === 'existing_source_link' ||
    stage === 'global_identifier' ||
    stage === 'brand_scoped_identifier' ||
    stage === 'no_candidate'
  );
}

/** Everything the policy needs beyond the candidates themselves. */
export interface PolicyContext {
  readonly stage: MatchStage;
  /** Blockers that apply to the DECISION regardless of which candidate wins. */
  readonly decisionBlockers: readonly MatchBlocker[];
  /** Reason codes the pipeline already established (positive and neutral). */
  readonly reasonCodes: readonly MatchReasonCode[];
  /** Whether this category may match automatically under this policy. */
  readonly categoryAutomatic: boolean;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Choose the outcome.
 *
 * The order of the checks is the decision procedure and each one is a different
 * question:
 *
 * 1. **Is there anything to match?** No surviving candidate is `create_new` —
 *    the honest recommendation that this observation describes something the
 *    canonical catalogue does not have yet. It is never an automatic mint.
 * 2. **Is the best candidate distinguishable from the next?** Two candidates
 *    within `minCandidateSeparation` produce `ambiguous_candidates`. Without
 *    this, a policy with a 0.9 bar merges into whichever of two 0.97 candidates
 *    sorted first, which is a coin flip wearing a threshold's clothes.
 * 3. **Does anything forbid a merge?** Decision blockers, the winner's own
 *    blockers, the deterministic-support rule and the category gate, collected
 *    rather than short-circuited — an operator reading a review wants every
 *    reason, not the first one the code happened to test.
 * 4. **Is it confident enough?** At or above the automatic bar with no blocker,
 *    it is automatic. At or above the review bar, a person looks. Below it, the
 *    candidates were not plausible and the honest answer is `create_new`.
 */
export function decideOutcome(
  candidates: readonly ScoredCandidate[],
  policy: MatchPolicy,
  context: PolicyContext,
): PolicyDecision {
  const reasonCodes: MatchReasonCode[] = [...context.reasonCodes];
  const blockers: MatchBlocker[] = [...context.decisionBlockers];

  /**
   * `create_new` keeps the DECISION-level blockers and drops the candidate-level
   * ones, because the two say different things. A decision blocker is a fact
   * about the SUBJECT — its own identifiers disagree, an operator rejected it —
   * and it stays true whether or not a candidate was found; #60's backfill needs
   * it, since minting a canonical product from a self-contradicting observation
   * is the same mistake as merging into the wrong one. A candidate blocker is a
   * fact about a COMPARISON that did not end up happening, and recording it on a
   * decision that selected nothing would name a refusal nobody made.
   */
  const createNew = (): PolicyDecision => ({
    outcome: 'create_new',
    confidence: null,
    blockers: dedupe(context.decisionBlockers),
    reasonCodes: dedupe([...reasonCodes, ...context.decisionBlockers, 'no_candidate_found']),
    selected: null,
  });

  const surviving = candidates.filter((candidate) => candidate.rejection === null);
  if (surviving.length === 0) return createNew();

  const ranked = [...surviving].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    // A deterministic tiebreak, so two runs over the same catalogue produce the
    // same decision. Sorting by score alone leaves ties to `Array#sort`'s
    // stability over whatever order the retrieval happened to return.
    const leftKey = `${left.canonicalVariantId ?? ''}:${left.canonicalProductId ?? ''}`;
    const rightKey = `${right.canonicalVariantId ?? ''}:${right.canonicalProductId ?? ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const best = ranked[0];
  if (!best) return createNew();
  const runnerUp = ranked[1];

  blockers.push(...best.blockers);

  if (runnerUp !== undefined && best.score - runnerUp.score < policy.minCandidateSeparation) {
    blockers.push('ambiguous_candidates');
  }
  if (!hasDeterministicSupport(best.features)) {
    blockers.push('no_deterministic_support');
  }
  if (GATED_MATCH_STAGES.includes(context.stage) && !context.categoryAutomatic) {
    blockers.push('category_gate_closed');
  }

  const deterministic = isDeterministicStage(context.stage);
  const confidence = deterministic ? null : computeConfidence(best.features, policy.weights);
  // A heuristic stage that produced no measurable feature cannot be scored, so
  // it cannot be automatic. Treating it as zero and as one are both inventions;
  // handing it to a person is not.
  const effective = confidence === null ? 0 : confidence;

  if (!deterministic && effective < policy.autoMinConfidence) {
    blockers.push('below_auto_threshold');
  }

  const finalBlockers = dedupe(blockers);
  reasonCodes.push(...finalBlockers);

  if (finalBlockers.length === 0) {
    return {
      outcome: 'automatic_match',
      confidence,
      blockers: [],
      reasonCodes: dedupe(reasonCodes),
      selected: best,
    };
  }

  // Below the REVIEW bar there is nothing worth a person's time either: the
  // candidates were retrieved, scored, and found not to be this thing. That is
  // the same answer as having found nothing, and saying so keeps the review
  // queue about genuine ambiguity.
  if (!deterministic && effective < policy.reviewMinConfidence) return createNew();

  return {
    outcome: 'manual_review',
    confidence,
    blockers: finalBlockers,
    reasonCodes: dedupe(reasonCodes),
    selected: best,
  };
}
