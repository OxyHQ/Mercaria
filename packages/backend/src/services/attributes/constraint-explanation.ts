/**
 * The user-facing explanation of an evaluation (#94 hard-constraint rule 5,
 * API rule 5).
 *
 * "User-visible results explain which requirements were satisfied, failed or
 * unknown" is a product requirement with a security-shaped edge: the explanation
 * is the ONE place internal matching detail could leak into a public response.
 * So this module composes from the {@link ConstraintEvaluation} alone — it takes
 * no database handle, reads no provenance, and names no source record, source
 * id, confidence number or normalization method. What a shopper gets is which
 * requirement, what happened, and whether Mercaria has a recorded observation
 * behind the answer.
 *
 * `sourceBacked` is the deliberate exception to that reticence, and it is #94
 * API rule 7's "enough context for trust": knowing that a match came from a
 * recorded fact rather than from an absence is what makes the answer worth
 * anything, and it discloses nothing about WHICH source.
 */

import type {
  ConstraintEvaluation,
  ConstraintOutcome,
  ConstraintSatisfaction,
} from '@mercaria/shared-types';

/** One line of an explanation, ready to render. */
export interface ExplainedRequirement {
  readonly constraintId: string;
  readonly requirement: string;
  readonly outcome: ConstraintSatisfaction;
  readonly detail: string;
  readonly hard: boolean;
  readonly sourceBacked: boolean;
}

/** The whole explanation, grouped the way a shopper reads it. */
export interface ConstraintExplanation {
  readonly entityKind: 'product' | 'variant';
  readonly entityId: string;
  readonly included: boolean;
  readonly matched: readonly ExplainedRequirement[];
  readonly failed: readonly ExplainedRequirement[];
  readonly unknown: readonly ExplainedRequirement[];
  /** Satisfied preferences over total preferences, in [0, 1]. */
  readonly preferenceScore: number;
  /** One sentence summarising the verdict. */
  readonly summary: string;
  readonly evaluationVersion: string;
  readonly normalizationRuleVersion: string;
}

/**
 * Turn an evaluation into an explanation.
 *
 * The grouping is by OUTCOME rather than by strength, because that is the
 * question a shopper is asking ("what didn't match?"), while the strength stays
 * on each line so the UI can mark a failed hard requirement differently from a
 * missed preference. Both are needed: a list that hid the strength would present
 * "we'd have preferred blue" with the same weight as "this is not waterproof".
 */
export function explainEvaluation(evaluation: ConstraintEvaluation): ConstraintExplanation {
  const lines = [
    ...evaluation.hardOutcomes.map((outcome) => toLine(outcome, true)),
    ...evaluation.preferenceOutcomes.map((outcome) => toLine(outcome, false)),
  ];

  const matched = lines.filter((line) => line.outcome === 'satisfied');
  const failed = lines.filter((line) => line.outcome === 'failed');
  const unknown = lines.filter((line) => line.outcome === 'unknown');

  return {
    entityKind: evaluation.entityKind,
    entityId: evaluation.entityId,
    included: evaluation.verdict === 'included',
    matched,
    failed,
    unknown,
    preferenceScore: evaluation.preferenceScore,
    summary: summarize(evaluation, matched.length, failed.length, unknown.length),
    evaluationVersion: evaluation.evaluationVersion,
    normalizationRuleVersion: evaluation.normalizationRuleVersion,
  };
}

function toLine(outcome: ConstraintOutcome, hard: boolean): ExplainedRequirement {
  return {
    constraintId: outcome.constraintId,
    requirement: outcome.explanation,
    outcome: outcome.satisfaction,
    detail: outcome.reason,
    hard,
    sourceBacked: outcome.sourceBacked,
  };
}

/**
 * The one-sentence summary.
 *
 * An EXCLUDED candidate names the requirements it failed, because "no results"
 * with no reason is the single most common way a filtered catalogue looks
 * broken. An included one that carries unknowns says so rather than reading as a
 * clean match — a product admitted under `admit_and_report_unknown` has NOT been
 * shown to meet the requirement, and a summary that implied otherwise would be
 * the quiet downgrade rule 4 forbids.
 */
function summarize(
  evaluation: ConstraintEvaluation,
  matched: number,
  failed: number,
  unknown: number,
): string {
  if (evaluation.verdict === 'excluded') {
    const failedHard = evaluation.hardOutcomes.filter(
      (outcome) => outcome.satisfaction === 'failed',
    );
    return `Excluded: ${failedHard.map((outcome) => outcome.explanation).join('; ')}.`;
  }
  if (unknown > 0) {
    return `Meets ${matched} requirement${matched === 1 ? '' : 's'}; ${unknown} could not be checked because the data is not recorded.`;
  }
  if (failed > 0) {
    return `Meets every requirement; ${failed} preference${failed === 1 ? '' : 's'} did not match.`;
  }
  return `Meets every requirement.`;
}
