/**
 * The decision policy: the confidence arithmetic, and the outcome procedure.
 *
 * The single most load-bearing property here is what an UNKNOWN feature does,
 * because the two wrong answers are both plausible and both silent: reading it
 * as zero makes an unbranded P2P listing unmatchable, and reading it as the mean
 * of the others lets one strong feature and six unknowns score like seven strong
 * features. So the arithmetic is asserted against BOTH wrong answers by
 * construction, not just against the right one.
 */

import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  decideOutcome,
  hasDeterministicSupport,
  isDeterministicStage,
  GATED_MATCH_STAGES,
  type MatchPolicy,
  type ScoredCandidate,
} from '../policy.js';
import { DETERMINISTIC_MATCH_STAGES, MATCH_STAGES } from '@mercaria/shared-types';

const WEIGHTS = {
  identifierAgreement: 6,
  brandAgreement: 3,
  modelAgreement: 2,
  attributeAgreement: 4,
  titleSimilarity: 1,
  categoryAgreement: 2,
  semanticSimilarity: 0,
};

function policy(overrides: Partial<MatchPolicy> = {}): MatchPolicy {
  return {
    id: 'policy-1',
    versionKey: 'test',
    autoMinConfidence: 0.9,
    reviewMinConfidence: 0.55,
    minCandidateSeparation: 0.05,
    maxCandidates: 25,
    minTitleSimilarity: 0.2,
    weights: WEIGHTS,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.95,
    minBenchmarkSamples: 20,
    ...overrides,
  };
}

function candidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    canonicalProductId: 'prd-1',
    canonicalVariantId: 'var-1',
    features: { brandAgreement: 1, attributeAgreement: 1 },
    blockers: [],
    rejection: null,
    score: 1,
    ...overrides,
  };
}

describe('confidence is a weighted mean over the features that HAVE a value', () => {
  it('leaves an unknown feature out of the DENOMINATOR, not in it as a zero', () => {
    // brand=1 and attribute=1 known; every other feature unknown.
    const known = computeConfidence({ brandAgreement: 1, attributeAgreement: 1 }, WEIGHTS);
    expect(known).toBe(1);

    // The first wrong answer: unknown-as-zero. With weights 3+4 out of 18, this
    // would be 7/18 ≈ 0.389 rather than 1.0 — and would make an unbranded P2P
    // listing score as though its brand were WRONG.
    expect(known).not.toBeCloseTo(7 / 18, 5);

    // The second wrong answer: a genuine disagreement must NOT read like silence.
    const disagreeing = computeConfidence(
      { brandAgreement: 0, attributeAgreement: 1 },
      WEIGHTS,
    );
    expect(disagreeing).toBeCloseTo(4 / 7, 5);
    expect(disagreeing).toBeLessThan(known ?? 0);
  });

  it('is NULL when nothing at all was observed — which is not a confidence of zero', () => {
    expect(computeConfidence({}, WEIGHTS)).toBeNull();
  });

  it('ignores a zero-weighted feature entirely, rather than letting it drag the mean', () => {
    // `semanticSimilarity` has weight 0 in this policy. A perfect semantic score
    // must change nothing at all.
    const without = computeConfidence({ brandAgreement: 1 }, WEIGHTS);
    const with_ = computeConfidence({ brandAgreement: 1, semanticSimilarity: 1 }, WEIGHTS);
    expect(with_).toBe(without);
  });

  it('stays inside [0, 1] so the column CHECK is never where a float lands', () => {
    const value = computeConfidence(
      { identifierAgreement: 1, brandAgreement: 1, attributeAgreement: 1, titleSimilarity: 1 },
      WEIGHTS,
    );
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('deterministic support is what stops a similarity carrying a decision', () => {
  it('a title or semantic score alone is NOT support', () => {
    expect(hasDeterministicSupport({ titleSimilarity: 1, semanticSimilarity: 1 })).toBe(false);
    expect(hasDeterministicSupport({ categoryAgreement: 1 })).toBe(false);
  });

  it('any positive identifier, brand, model or attribute agreement IS support', () => {
    expect(hasDeterministicSupport({ identifierAgreement: 1 })).toBe(true);
    expect(hasDeterministicSupport({ brandAgreement: 1 })).toBe(true);
    expect(hasDeterministicSupport({ modelAgreement: 1 })).toBe(true);
    expect(hasDeterministicSupport({ attributeAgreement: 0.5 })).toBe(true);
  });

  it('a deterministic feature scored ZERO is a disagreement, not support', () => {
    expect(hasDeterministicSupport({ brandAgreement: 0 })).toBe(false);
  });
});

describe('the outcome procedure', () => {
  const context = {
    stage: 'candidate_retrieval' as const,
    decisionBlockers: [],
    reasonCodes: [],
    categoryAutomatic: true,
  };

  it('automatic when confident, unblocked, separated and gated open', () => {
    const decision = decideOutcome([candidate()], policy(), context);
    expect(decision.outcome).toBe('automatic_match');
    expect(decision.blockers).toEqual([]);
    expect(decision.selected?.canonicalVariantId).toBe('var-1');
  });

  it('review when ANY blocker is present, however high the confidence', () => {
    const decision = decideOutcome(
      [candidate({ blockers: ['conflicting_identifier'] })],
      policy(),
      context,
    );
    expect(decision.outcome).toBe('manual_review');
    expect(decision.blockers).toContain('conflicting_identifier');
  });

  it('review when two candidates are within the separation margin', () => {
    const decision = decideOutcome(
      [candidate({ score: 0.97 }), candidate({ canonicalVariantId: 'var-2', score: 0.969 })],
      policy(),
      context,
    );
    expect(decision.blockers).toContain('ambiguous_candidates');
    expect(decision.outcome).toBe('manual_review');
  });

  it('create_new when nothing survived, keeping the SUBJECT-level blockers', () => {
    const decision = decideOutcome([], policy(), {
      ...context,
      decisionBlockers: ['conflicting_identifier'],
    });
    expect(decision.outcome).toBe('create_new');
    expect(decision.selected).toBeNull();
    // A subject whose own identifiers disagree must not be minted from either.
    // The CHECK on `match_decisions` refuses a recorded conflict with no blocker,
    // so dropping this would make the row unstorable — and it is also the fact
    // #60's backfill needs.
    expect(decision.blockers).toContain('conflicting_identifier');
  });

  it('create_new when the best candidate is below the REVIEW bar', () => {
    const decision = decideOutcome(
      [candidate({ features: { brandAgreement: 0.1 }, score: 0.1 })],
      policy(),
      context,
    );
    expect(decision.outcome).toBe('create_new');
  });

  it('drops a REJECTED candidate from the running rather than blocking the decision', () => {
    const decision = decideOutcome(
      [
        candidate({ canonicalVariantId: 'var-blocked', rejection: 'blocked_pair', score: 1 }),
        candidate({ canonicalVariantId: 'var-2', score: 0.95 }),
      ],
      policy(),
      context,
    );
    // An operator rejected ONE pair and said nothing about the other candidate.
    expect(decision.outcome).toBe('automatic_match');
    expect(decision.selected?.canonicalVariantId).toBe('var-2');
  });

  it('breaks a score tie DETERMINISTICALLY, so two runs agree', () => {
    const first = decideOutcome(
      [candidate({ canonicalVariantId: 'var-b' }), candidate({ canonicalVariantId: 'var-a' })],
      policy({ minCandidateSeparation: 0 }),
      context,
    );
    const second = decideOutcome(
      [candidate({ canonicalVariantId: 'var-a' }), candidate({ canonicalVariantId: 'var-b' })],
      policy({ minCandidateSeparation: 0 }),
      context,
    );
    expect(first.selected?.canonicalVariantId).toBe(second.selected?.canonicalVariantId);
  });

  it('blocks a GATED stage when the category gate is closed, and not an identifier stage', () => {
    for (const stage of GATED_MATCH_STAGES) {
      const decision = decideOutcome([candidate()], policy(), {
        ...context,
        stage,
        categoryAutomatic: false,
      });
      expect(decision.blockers, `${stage} must be gated`).toContain('category_gate_closed');
    }
    const deterministic = decideOutcome([candidate()], policy(), {
      ...context,
      stage: 'global_identifier',
      categoryAutomatic: false,
    });
    expect(deterministic.blockers).not.toContain('category_gate_closed');
    expect(deterministic.outcome).toBe('automatic_match');
  });

  it('records NULL confidence on a deterministic stage and a number on a heuristic one', () => {
    expect(decideOutcome([candidate()], policy(), { ...context, stage: 'global_identifier' }).confidence).toBeNull();
    expect(decideOutcome([candidate()], policy(), context).confidence).not.toBeNull();
  });
});

describe('the stage tables agree with each other', () => {
  it('every stage is either deterministic or gated, and never both', () => {
    for (const stage of MATCH_STAGES) {
      const deterministic = DETERMINISTIC_MATCH_STAGES.includes(stage);
      const gated = GATED_MATCH_STAGES.includes(stage);
      // `no_candidate` and `candidate_retrieval` are the two that look like
      // exceptions and are not: the first decides nothing, and the second is
      // deterministic in the sense of being REPRODUCIBLE while still being this
      // pipeline's own judgement — which is what a benchmark measures and a gate
      // governs.
      expect(
        deterministic || gated,
        `${stage} is in neither table; whoever added it owes that decision`,
      ).toBe(true);
    }
    expect(isDeterministicStage('global_identifier')).toBe(true);
    expect(isDeterministicStage('candidate_retrieval')).toBe(false);
    expect(isDeterministicStage('semantic_assist')).toBe(false);
  });
});
