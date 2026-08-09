/**
 * `match_decisions` and `match_decision_candidates` — the auditable record.
 *
 * ## The single-writer invariant this module holds
 *
 * `match_decisions_conflicting_identifier_check` enforces ONE direction — a
 * recorded conflicting identifier implies the blocker. The other direction is
 * not expressible as a CHECK over one row (it would have to know that the
 * pipeline computed a conflict), so {@link upsertMatchDecision} refuses it
 * before issuing SQL: the blocker present with an EMPTY identifier list is a
 * decision that says "something conflicts" and cannot say what, which is an
 * explanation an operator cannot act on.
 *
 * The ledger repository's rule, applied to a matcher: the only writer refuses
 * what the database cannot.
 *
 * ## Why the upsert is `DO UPDATE` and what it deliberately does not touch
 *
 * Re-evaluating a subject under the same policy converges on ONE row (#58
 * operations 1). `created_at` never moves — it is when this subject was FIRST
 * judged under this policy — and `evaluation_count` increments off the EXISTING
 * row rather than `excluded`, which is CONVENTIONS.md's third concurrency shape:
 * `excluded` is the row this statement proposed, so two concurrent
 * re-evaluations would each set the count to their own proposed value.
 *
 * A human REVIEW verdict is likewise never overwritten by a re-evaluation. An
 * operator who rejected a match must not have that judgement erased because a
 * dispatcher re-ran the pipeline; #59 owns the review columns and this module
 * writes them only through {@link recordMatchReview}.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  MatchBlocker,
  MatchOutcome,
  MatchReasonCode,
  MatchStage,
  MatchSubjectKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { matchDecisionCandidates, matchDecisions } from '../schema/matching.js';

export type MatchDecisionRow = typeof matchDecisions.$inferSelect;
export type MatchDecisionCandidateRow = typeof matchDecisionCandidates.$inferSelect;

/** One candidate row, as the service hands it over. */
export interface MatchDecisionCandidateInput {
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly rank: number;
  readonly score: number;
  readonly selected: boolean;
  readonly rejection: MatchBlocker | null;
  readonly identifierAgreement?: number;
  readonly brandAgreement?: number;
  readonly modelAgreement?: number;
  readonly attributeAgreement?: number;
  readonly titleSimilarity?: number;
  readonly categoryAgreement?: number;
  readonly semanticSimilarity?: number;
}

export interface UpsertMatchDecisionInput {
  readonly subjectKind: MatchSubjectKind;
  readonly subjectKey: string;
  readonly sourceRecordId: string | null;
  readonly productVariantId: string | null;
  readonly policyVersionId: string;
  readonly outcome: MatchOutcome;
  readonly decidedStage: MatchStage;
  readonly confidence: number | null;
  readonly matchedCanonicalProductId: string | null;
  readonly matchedCanonicalVariantId: string | null;
  readonly reasonCodes: readonly MatchReasonCode[];
  readonly blockers: readonly MatchBlocker[];
  readonly positiveIdentifiers: readonly string[];
  readonly conflictingIdentifiers: readonly string[];
  readonly normalizedBrand: string | null;
  readonly normalizedModel: string | null;
  readonly normalizedTitle: string;
  readonly categoryKey: string | null;
  readonly candidates: readonly MatchDecisionCandidateInput[];
  readonly now: Date;
}

/** The check the database cannot make. See the module note. */
export class UnexplainedConflictError extends Error {
  constructor(subjectKey: string) {
    super(
      `Refusing to store a match decision for ${subjectKey}: it carries the ` +
        `'conflicting_identifier' blocker with no conflicting identifier recorded. ` +
        `A refusal an operator cannot read is not an explanation.`,
    );
    this.name = 'UnexplainedConflictError';
  }
}

/**
 * Write (or converge on) one decision and REPLACE its candidate rows.
 *
 * Candidates are deleted and re-inserted rather than upserted: they are a
 * snapshot of one evaluation against a catalogue at one moment, and a catalogue
 * that has since gained or lost a product must not leave a stale candidate row
 * beside the fresh ones claiming it was considered. Everything runs in the
 * caller's transaction, so a decision never commits without its candidates.
 */
export async function upsertMatchDecision(
  db: DatabaseOrTransaction,
  input: UpsertMatchDecisionInput,
): Promise<MatchDecisionRow> {
  if (input.blockers.includes('conflicting_identifier') && input.conflictingIdentifiers.length === 0) {
    throw new UnexplainedConflictError(input.subjectKey);
  }

  const reviewState = input.outcome === 'manual_review' ? 'pending' : 'not_required';

  const rows = await db
    .insert(matchDecisions)
    .values({
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      sourceRecordId: input.sourceRecordId,
      productVariantId: input.productVariantId,
      policyVersionId: input.policyVersionId,
      outcome: input.outcome,
      decidedStage: input.decidedStage,
      confidence: input.confidence,
      matchedCanonicalProductId: input.matchedCanonicalProductId,
      matchedCanonicalVariantId: input.matchedCanonicalVariantId,
      reasonCodes: [...input.reasonCodes],
      blockers: [...input.blockers],
      positiveIdentifiers: [...input.positiveIdentifiers],
      conflictingIdentifiers: [...input.conflictingIdentifiers],
      normalizedBrand: input.normalizedBrand,
      normalizedModel: input.normalizedModel,
      normalizedTitle: input.normalizedTitle,
      categoryKey: input.categoryKey,
      candidateCount: input.candidates.length,
      reviewState,
      evaluationCount: 1,
      lastEvaluatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [matchDecisions.evaluationKey, matchDecisions.policyVersionId],
      set: {
        outcome: input.outcome,
        decidedStage: input.decidedStage,
        confidence: input.confidence,
        matchedCanonicalProductId: input.matchedCanonicalProductId,
        matchedCanonicalVariantId: input.matchedCanonicalVariantId,
        reasonCodes: [...input.reasonCodes],
        blockers: [...input.blockers],
        positiveIdentifiers: [...input.positiveIdentifiers],
        conflictingIdentifiers: [...input.conflictingIdentifiers],
        normalizedBrand: input.normalizedBrand,
        normalizedModel: input.normalizedModel,
        normalizedTitle: input.normalizedTitle,
        categoryKey: input.categoryKey,
        candidateCount: input.candidates.length,
        /**
         * A re-evaluation REOPENS a review only when the fresh outcome asks for
         * one AND nobody has answered the old one. An operator's `approved` or
         * `rejected` verdict survives every subsequent run — the alternative
         * erases a person's judgement because a dispatcher woke up, which is
         * both wrong and undetectable after the fact.
         */
        reviewState: sql`case
            when ${matchDecisions.reviewState} in ('approved', 'rejected') then ${matchDecisions.reviewState}
            when ${input.outcome} = 'manual_review' then 'pending'
            else 'not_required'
          end`,
        // The EXISTING row, never `excluded` — CONVENTIONS.md's third shape.
        evaluationCount: sql`${matchDecisions.evaluationCount} + 1`,
        lastEvaluatedAt: input.now,
      },
    })
    .returning();

  const decision = rows[0];
  if (!decision) throw new Error('upsertMatchDecision returned no row.');

  await db
    .delete(matchDecisionCandidates)
    .where(eq(matchDecisionCandidates.decisionId, decision.id));

  if (input.candidates.length > 0) {
    await db.insert(matchDecisionCandidates).values(
      input.candidates.map((candidate) => ({
        decisionId: decision.id,
        canonicalProductId: candidate.canonicalProductId,
        canonicalVariantId: candidate.canonicalVariantId,
        rank: candidate.rank,
        score: candidate.score,
        selected: candidate.selected,
        rejection: candidate.rejection,
        identifierAgreement: candidate.identifierAgreement ?? null,
        brandAgreement: candidate.brandAgreement ?? null,
        modelAgreement: candidate.modelAgreement ?? null,
        attributeAgreement: candidate.attributeAgreement ?? null,
        titleSimilarity: candidate.titleSimilarity ?? null,
        categoryAgreement: candidate.categoryAgreement ?? null,
        semanticSimilarity: candidate.semanticSimilarity ?? null,
      })),
    );
  }

  return decision;
}

export async function findMatchDecisionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MatchDecisionRow | undefined> {
  const rows = await db.select().from(matchDecisions).where(eq(matchDecisions.id, id)).limit(1);
  return rows[0];
}

/** Every decision ever made about one subject, newest first. */
export async function listMatchDecisionsForSubject(
  db: DatabaseOrTransaction,
  subjectKey: string,
  limit = 20,
): Promise<MatchDecisionRow[]> {
  return db
    .select()
    .from(matchDecisions)
    .where(eq(matchDecisions.subjectKey, subjectKey))
    .orderBy(desc(matchDecisions.createdAt))
    .limit(limit);
}

export async function listMatchDecisionCandidates(
  db: DatabaseOrTransaction,
  decisionId: string,
): Promise<MatchDecisionCandidateRow[]> {
  return db
    .select()
    .from(matchDecisionCandidates)
    .where(eq(matchDecisionCandidates.decisionId, decisionId))
    .orderBy(matchDecisionCandidates.rank);
}

/** #59's inbox: what is waiting for a person, oldest first. */
export async function listPendingMatchReviews(
  db: DatabaseOrTransaction,
  input: { policyVersionId?: string; limit: number },
): Promise<MatchDecisionRow[]> {
  const predicate =
    input.policyVersionId === undefined
      ? eq(matchDecisions.reviewState, 'pending')
      : and(
          eq(matchDecisions.reviewState, 'pending'),
          eq(matchDecisions.policyVersionId, input.policyVersionId),
        );
  return db
    .select()
    .from(matchDecisions)
    .where(predicate)
    .orderBy(matchDecisions.createdAt)
    .limit(input.limit);
}

/**
 * Record a person's verdict.
 *
 * A one-statement CAS on `review_state = 'pending'`, so a second reviewer
 * answering the same decision writes nothing and the first verdict stands — and
 * a re-evaluation that has already closed the review cannot be overwritten
 * either.
 */
export async function recordMatchReview(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    state: 'approved' | 'rejected';
    reviewedByOxyUserId: string;
    note: string;
    now: Date;
  },
): Promise<MatchDecisionRow | undefined> {
  const rows = await db
    .update(matchDecisions)
    .set({
      reviewState: input.state,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      reviewedAt: input.now,
      reviewNote: input.note,
    })
    .where(and(eq(matchDecisions.id, input.id), eq(matchDecisions.reviewState, 'pending')))
    .returning();
  return rows[0];
}

/** The observability numbers (#58 operations 5). */
export interface DecisionMetrics {
  readonly total: number;
  readonly ambiguous: number;
  readonly pendingReview: number;
}

export async function summarizeDecisions(
  db: DatabaseOrTransaction,
  policyVersionId: string,
): Promise<DecisionMetrics> {
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      // A GIN index on `blockers` serves the containment predicate; the
      // ambiguity RATE is what tells a stopped catalogue apart from a policy
      // whose separation threshold no longer fits it.
      ambiguous: sql<number>`count(*) filter (where ${matchDecisions.blockers} @> array['ambiguous_candidates']::text[])::int`,
      pendingReview: sql<number>`count(*) filter (where ${matchDecisions.reviewState} = 'pending')::int`,
    })
    .from(matchDecisions)
    .where(eq(matchDecisions.policyVersionId, policyVersionId));
  return rows[0] ?? { total: 0, ambiguous: 0, pendingReview: 0 };
}

/**
 * The decision that produced a given native attachment, when there is one.
 *
 * Used by the operator trace to answer "why is this listing attached to that
 * canonical variant" from the attachment rather than from the subject.
 */
export async function findLatestDecisionForVariant(
  db: DatabaseOrTransaction,
  productVariantId: string,
): Promise<MatchDecisionRow | undefined> {
  const rows = await db
    .select()
    .from(matchDecisions)
    .where(eq(matchDecisions.productVariantId, productVariantId))
    .orderBy(desc(matchDecisions.lastEvaluatedAt))
    .limit(1);
  return rows[0];
}
