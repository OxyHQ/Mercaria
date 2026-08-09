/**
 * Publishing a policy version, opening a category gate, and recording a rejected
 * pair (#58 operations 2, acceptance 4 and 5).
 *
 * Three operator actions and nothing else. Each one writes a fact that the
 * pipeline then READS, which is the shape that keeps a matcher auditable: an
 * operator changes the rules, and the change is a row somebody can point at
 * afterwards.
 *
 * ## The gate check that a CHECK cannot make
 *
 * `match_category_gates` already refuses — by NOT NULL composite foreign key — a
 * gate with no benchmark citation and a gate citing a run measured under a
 * different policy. What remains is a comparison BETWEEN tables: did the cited
 * slice's generated `precision` clear the policy's `min_benchmark_precision`, on
 * at least `min_benchmark_samples` positive cases. A CHECK may not contain a
 * subquery, so this is the enforcement point, and it is stated here rather than
 * spread across a route handler so there is exactly one place to get it wrong.
 *
 * The sample floor is not decoration. A slice with two true positives and no
 * false positives reports a precision of 1.0, and opening automatic matching for
 * a whole category on two examples is how a benchmark becomes theatre.
 */

import type { MatchSubjectKind } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  activateMatchPolicyVersion,
  closeCategoryGate,
  findBenchmarkCitation,
  findMatchPolicyVersionById,
  insertCategoryGate,
  insertMatchPolicyVersion,
  type MatchCategoryGateRow,
  type MatchPolicyVersionRow,
} from '../../db/matching/matchPolicyRepository.js';
import {
  blockPair,
  clearBlockedPair,
  findBlockedPairById,
  type MatchBlockedPairRow,
} from '../../db/matching/matchBlockedPairRepository.js';
import { findMatchDecisionById } from '../../db/matching/matchDecisionRepository.js';

export interface CreateMatchPolicyInput {
  readonly versionKey: string;
  readonly description: string;
  readonly autoMinConfidence: number;
  readonly reviewMinConfidence: number;
  readonly minCandidateSeparation: number;
  readonly maxCandidates: number;
  readonly minTitleSimilarity: number;
  readonly weightIdentifier: number;
  readonly weightBrand: number;
  readonly weightModel: number;
  readonly weightAttribute: number;
  readonly weightTitle: number;
  readonly weightCategory: number;
  readonly weightSemantic: number;
  readonly semanticEnabled: boolean;
  readonly minBenchmarkPrecision: number;
  readonly minBenchmarkSamples: number;
  readonly createdByOxyUserId: string;
}

/** Draft a policy version. Drafts are editable; activation freezes them. */
export async function createMatchPolicyVersion(
  input: CreateMatchPolicyInput,
): Promise<MatchPolicyVersionRow> {
  return insertMatchPolicyVersion(getDb(), { ...input, status: 'draft' });
}

/**
 * Activate a draft, superseding whichever version was active.
 *
 * One transaction, and the supersede runs BEFORE the activate: the reverse order
 * transiently holds two active rows, which `match_policy_versions_active_key`
 * refuses outright. A failed transaction is the outcome to prefer when an order
 * is load-bearing.
 */
export async function activateMatchPolicy(
  policyVersionId: string,
  now: Date = new Date(),
): Promise<MatchPolicyVersionRow> {
  return getDb().transaction(async (tx) => {
    const existing = await findMatchPolicyVersionById(tx, policyVersionId);
    if (!existing) throw notFound(`Match policy version ${policyVersionId} does not exist.`);
    if (existing.status !== 'draft') {
      throw conflict(
        `Match policy version ${existing.versionKey} is '${existing.status}'; only a draft can be activated.`,
      );
    }
    const activated = await activateMatchPolicyVersion(tx, { id: policyVersionId, now });
    if (!activated) {
      throw conflict('The policy version changed while being activated; re-read it and retry.');
    }
    return activated;
  });
}

export interface OpenGateInput {
  readonly policyVersionId: string;
  readonly categoryKey: string;
  readonly benchmarkCategoryId: string;
  readonly enabledByOxyUserId: string;
  readonly reason: string;
}

/**
 * Enable AUTOMATIC matching for one category, citing the measurement that
 * permits it (#58 acceptance 5).
 *
 * Every refusal below names the number it saw, because an operator told "the
 * gate cannot be opened" and not told why will open it against a different
 * benchmark until one passes.
 */
export async function openCategoryGate(
  input: OpenGateInput,
  now: Date = new Date(),
): Promise<MatchCategoryGateRow> {
  return getDb().transaction(async (tx) => {
    const policy = await findMatchPolicyVersionById(tx, input.policyVersionId);
    if (!policy) throw notFound(`Match policy version ${input.policyVersionId} does not exist.`);

    const citation = await findBenchmarkCitation(tx, input.benchmarkCategoryId);
    if (!citation) {
      throw notFound(`Benchmark slice ${input.benchmarkCategoryId} does not exist.`);
    }
    // The composite foreign key refuses this too. Checking it here as well turns
    // a 23503 into a sentence an operator can act on, and the two cannot
    // disagree because the database has the last word either way.
    if (citation.policyVersionId !== input.policyVersionId) {
      throw validationError(
        `Benchmark slice ${input.benchmarkCategoryId} was measured under a different policy version; a gate must cite a run of the policy it governs.`,
      );
    }
    if (citation.categoryKey !== input.categoryKey) {
      throw validationError(
        `Benchmark slice ${input.benchmarkCategoryId} measures category '${citation.categoryKey}', not '${input.categoryKey}'.`,
      );
    }

    const samples = citation.truePositives + citation.falsePositives;
    if (samples < policy.minBenchmarkSamples) {
      throw validationError(
        `Benchmark slice for '${input.categoryKey}' predicted ${String(samples)} positives; policy ${policy.versionKey} requires at least ${String(policy.minBenchmarkSamples)}. A precision measured on a handful of cases is not a measurement.`,
      );
    }
    const precision = citation.precision;
    if (precision === null || precision < policy.minBenchmarkPrecision) {
      throw validationError(
        `Benchmark precision for '${input.categoryKey}' is ${precision === null ? 'undefined (no positives predicted)' : precision.toFixed(4)}; policy ${policy.versionKey} requires at least ${policy.minBenchmarkPrecision.toFixed(4)}.`,
      );
    }

    return insertCategoryGate(tx, {
      policyVersionId: input.policyVersionId,
      categoryKey: input.categoryKey,
      benchmarkCategoryId: input.benchmarkCategoryId,
      observedPrecision: precision,
      observedSamples: samples,
      enabledByOxyUserId: input.enabledByOxyUserId,
      reason: input.reason,
      now,
    });
  });
}

/** Disable automatic matching for one category. Attributable, by CHECK. */
export async function closeGate(
  input: { gateId: string; disabledByOxyUserId: string; reason: string },
  now: Date = new Date(),
): Promise<void> {
  const closed = await closeCategoryGate(getDb(), {
    id: input.gateId,
    disabledByOxyUserId: input.disabledByOxyUserId,
    reason: input.reason,
    now,
  });
  if (!closed) throw conflict(`Category gate ${input.gateId} is not open.`);
}

export interface RejectMatchInput {
  readonly subjectKey: string;
  readonly subjectKind: MatchSubjectKind;
  readonly targetCanonicalProductId: string | null;
  readonly targetCanonicalVariantId: string | null;
  readonly decisionId: string | null;
  readonly blockedByOxyUserId: string;
  readonly reason: string;
}

/**
 * Record that a pair is WRONG, so it is never proposed again (#58 acceptance 4).
 *
 * Blocking the same pair twice is a genuine no-op — the open-block partial
 * unique absorbs it and the first person's reason stands — so an operator
 * re-rejecting something is not an error to explain away.
 *
 * The policy version is read from the decision when there is one and from the
 * active policy otherwise. It is recorded for the AUDIT trail and never as a
 * scope: a block that expired on the next policy version would silently
 * re-propose every rejected pair on a tuning change, which is the exact failure
 * acceptance 4 names.
 */
export async function rejectMatchPair(input: RejectMatchInput): Promise<MatchBlockedPairRow> {
  if (
    (input.targetCanonicalProductId === null) ===
    (input.targetCanonicalVariantId === null)
  ) {
    throw validationError('A blocked pair names exactly one target: a product or a variant.');
  }

  return getDb().transaction(async (tx) => {
    const decision =
      input.decisionId === null ? undefined : await findMatchDecisionById(tx, input.decisionId);
    if (input.decisionId !== null && !decision) {
      throw notFound(`Match decision ${input.decisionId} does not exist.`);
    }
    const policyVersionId = decision?.policyVersionId;
    if (policyVersionId === undefined) {
      throw validationError(
        'A blocked pair records the policy it was judged under; supply a decision id.',
      );
    }

    const created = await blockPair(tx, {
      subjectKey: input.subjectKey,
      subjectKind: input.subjectKind,
      targetCanonicalProductId: input.targetCanonicalProductId,
      targetCanonicalVariantId: input.targetCanonicalVariantId,
      decisionId: input.decisionId,
      blockedUnderPolicyVersionId: policyVersionId,
      blockedByOxyUserId: input.blockedByOxyUserId,
      reason: input.reason,
    });
    if (created) return created;
    // The open-block partial unique absorbed it: this pair is already rejected,
    // and the first person's reason is the recorded one. A conflict rather than
    // a silent success, so an operator who thought they were recording a NEW
    // judgement learns that somebody already made it.
    throw conflict('This pair is already blocked.');
  });
}

/** Lift a rejection, attributably (#58 acceptance 4: "until evidence changes"). */
export async function clearRejectedPair(
  input: { blockedPairId: string; clearedByOxyUserId: string; reason: string },
  now: Date = new Date(),
): Promise<MatchBlockedPairRow> {
  const db = getDb();
  const cleared = await clearBlockedPair(db, {
    id: input.blockedPairId,
    clearedByOxyUserId: input.clearedByOxyUserId,
    reason: input.reason,
    now,
  });
  if (!cleared) throw conflict(`Blocked pair ${input.blockedPairId} is not open.`);
  const row = await findBlockedPairById(db, input.blockedPairId);
  if (!row) throw notFound(`Blocked pair ${input.blockedPairId} does not exist.`);
  return row;
}
