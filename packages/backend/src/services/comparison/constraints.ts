/**
 * Constraint outcomes as a comparison COLUMN (#96 product-comparison rule 3).
 *
 * PURE, and deliberately thin: #94 owns whether a requirement is satisfied and
 * this domain owns only how the four states are presented. Nothing here
 * evaluates a predicate, reads a fact or decides a verdict.
 *
 * ## The reclassification never touches the verdict, and that is acceptance 5
 *
 * #96 asks for satisfied, failed, unknown and NOT-APPLICABLE kept apart, and
 * #94's evaluator answers only the first three. The fourth is derived here from
 * the subject's category scope: a requirement about battery life is not
 * *unknown* for a desk chair, it does not apply.
 *
 * But `not_applicable` is a PRESENTATION bucket and never a verdict input.
 * `verdict` is taken verbatim from {@link ConstraintEvaluation.verdict}, which
 * #94 derived from the hard outcomes under each constraint's own named
 * missing-data policy — so a hard requirement that #94 turned into a failure
 * because the fact was missing STAYS a failure here, whatever this module
 * thinks of the category scope. Reclassifying it would be exactly the quiet
 * downgrade of a hard constraint that #96 acceptance 5 ("hard constraints are
 * never relaxed to complete a basket") forbids, arriving through a display
 * concern rather than through the solver.
 *
 * Only an `unknown` outcome is ever moved, and moving it changes nothing a
 * shopper is or is not shown — the candidate's inclusion was already decided.
 */

import type {
  ComparisonConstraintColumn,
  ComparisonConstraintResult,
  ConstraintEvaluation,
  ConstraintOutcome,
  ProductConstraint,
} from '@mercaria/shared-types';

/** What the column builder needs about one subject. */
export interface ConstraintColumnInput {
  readonly subjectRef: string;
  readonly evaluation: ConstraintEvaluation;
  /** Every constraint in the validated set, hard and preference alike. */
  readonly constraints: readonly ProductConstraint[];
  /** Constraint id → its opaque record ref. */
  readonly constraintRefs: ReadonlyMap<string, string>;
  /** Attribute keys the subject's category declares. */
  readonly declaredAttributeKeys: ReadonlySet<string>;
}

/**
 * One subject's constraint column, with the four states separated.
 *
 * Every outcome lands in exactly one list — the lists are a PARTITION, asserted
 * by the benchmark suite, because a result appearing in two of them would let a
 * client count "3 satisfied of 4" beside "2 failed".
 */
export function buildConstraintColumn(
  input: ConstraintColumnInput,
): ComparisonConstraintColumn {
  const byId = new Map(input.constraints.map((constraint) => [constraint.id, constraint]));

  const satisfied: ComparisonConstraintResult[] = [];
  const failed: ComparisonConstraintResult[] = [];
  const unknown: ComparisonConstraintResult[] = [];
  const notApplicable: ComparisonConstraintResult[] = [];

  const outcomes: readonly ConstraintOutcome[] = [
    ...input.evaluation.hardOutcomes,
    ...input.evaluation.preferenceOutcomes,
  ];

  for (const outcome of outcomes) {
    const constraint = byId.get(outcome.constraintId);
    const applies = constraint === undefined || constraintApplies(constraint, input.declaredAttributeKeys);
    const satisfaction =
      outcome.satisfaction === 'unknown' && !applies ? 'not_applicable' : outcome.satisfaction;

    const result: ComparisonConstraintResult = {
      constraintRef: input.constraintRefs.get(outcome.constraintId) ?? outcome.constraintId,
      constraintId: outcome.constraintId,
      strength: outcome.strength,
      satisfaction,
      explanation: outcome.explanation,
      reason: outcome.reason,
      sourceBacked: outcome.sourceBacked,
    };

    if (satisfaction === 'satisfied') satisfied.push(result);
    else if (satisfaction === 'failed') failed.push(result);
    else if (satisfaction === 'not_applicable') notApplicable.push(result);
    else unknown.push(result);
  }

  return {
    subjectRef: input.subjectRef,
    // Verbatim from #94. See the module header for why nothing here recomputes it.
    verdict: input.evaluation.verdict,
    satisfied,
    failed,
    unknown,
    notApplicable,
  };
}

/**
 * Whether a constraint's question can be asked of this subject at all.
 *
 * Only an ATTRIBUTE constraint can be out of scope: a taxonomy question ("is it
 * this brand") and a commerce question ("is it under 300 €") apply to every
 * product in the catalogue, and answering `not_applicable` for one of those
 * would tell a shopper their price ceiling does not apply to a product it very
 * much does. An `any_of` GROUP is out of scope only when every member is, since
 * one answerable member makes the group answerable.
 */
function constraintApplies(
  constraint: ProductConstraint,
  declaredAttributeKeys: ReadonlySet<string>,
): boolean {
  if (constraint.kind === 'attribute') return declaredAttributeKeys.has(constraint.attributeKey);
  if (constraint.kind === 'any_of') {
    return constraint.members.some(
      (member) => member.kind !== 'attribute' || declaredAttributeKeys.has(member.attributeKey),
    );
  }
  return true;
}
