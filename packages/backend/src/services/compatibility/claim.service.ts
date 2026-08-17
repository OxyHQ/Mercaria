/**
 * Recording what a source said, and promoting one of those claims to the
 * canonical answer (#367 step 8, ADR 0007 D7).
 *
 * ## The two halves, and why they are two functions rather than one
 *
 * {@link recordCompatibilityClaim} stores what arrived. It NEVER creates a
 * canonical relation, whatever the claim says and whoever made it — that is D7
 * in one sentence, and it is why the function's return type has no relation id
 * to hand back. A feed asserting a million fitments produces a million claims
 * and zero published facts.
 *
 * {@link promoteClaimToRelation} and {@link promoteClaimToFitment} are the other
 * half: an explicit act that opens the canonical row and marks the claim as the
 * one it was selected from, in ONE transaction. Splitting them is what makes
 * "a merchant proposal never becomes globally trusted data by being submitted"
 * (D9's rule, D7's shape) a property of the call graph rather than a policy
 * somebody applies.
 *
 * ## An unresolved claim is a first-class outcome
 *
 * {@link recordCompatibilityClaim} takes an `unresolvedReason` and stores the
 * raw target text with it. There is deliberately no code path that DROPS a
 * claim it could not read: the class of claims that resolve to nothing is the
 * one an operator most needs, because it is the only evidence of what a feed was
 * trying to say, and because a feed whose format changed produces thousands of
 * them at once — which is a signal, and an empty table is not.
 */

import { conflict, validationError } from '../../lib/errors/index.js';
import type {
  CompatibilitySubject,
  CompatibilityUnresolvedReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  findClaimById,
  insertCompatibilityClaim,
  selectClaim,
  type CompatibilityClaimRow,
  type InsertCompatibilityClaim,
} from '../../db/compatibility/compatibilityClaimRepository.js';
import {
  openAutomotiveFitment,
  type AutomotiveFitmentRow,
  type InsertAutomotiveFitment,
} from '../../db/compatibility/automotiveFitmentRepository.js';
import {
  openCompatibilityRelation,
  type CompatibilityRelationRow,
  type InsertCompatibilityRelation,
} from '../../db/compatibility/compatibilityRelationRepository.js';

/** Everything a source supplies, plus what Mercaria could make of the target. */
export interface CompatibilityClaimInput {
  readonly subject?: CompatibilitySubject;
  readonly claim: Omit<
    InsertCompatibilityClaim,
    'id' | 'subjectProductId' | 'subjectVariantId' | 'state' | 'unresolvedReason'
  >;
  /**
   * Present when Mercaria could not resolve the target. Its presence IS the
   * `unresolved` state — the two cannot be supplied separately, so a caller
   * cannot store a resolved-looking claim that points at nothing.
   */
  readonly unresolvedReason?: CompatibilityUnresolvedReason;
}

/**
 * Store a claim exactly as it arrived. Creates no canonical fact, ever.
 *
 * A claim with no resolvable SUBJECT is still stored — `unknown_subject` is a
 * real reason, and the alternative (refusing it) throws away the evidence that a
 * source is publishing compatibility data for products Mercaria has not
 * matched yet, which is the signal that would have told somebody to run the
 * matcher over that feed.
 */
export async function recordCompatibilityClaim(
  input: CompatibilityClaimInput,
): Promise<CompatibilityClaimRow> {
  const subject = input.subject;
  const values: InsertCompatibilityClaim = {
    ...input.claim,
    subjectProductId:
      subject !== undefined && subject.kind === 'canonical_product' ? subject.productId : null,
    subjectVariantId:
      subject !== undefined && subject.kind === 'canonical_variant' ? subject.variantId : null,
    state: input.unresolvedReason === undefined ? 'corroborating' : 'unresolved',
    unresolvedReason: input.unresolvedReason ?? null,
  };
  if (input.unresolvedReason === undefined && subject === undefined) {
    throw validationError(
      'a resolved compatibility claim must name a subject; supply `unresolvedReason: "unknown_subject"` instead',
    );
  }
  return insertCompatibilityClaim(values);
}

/**
 * Open the canonical relation a claim asserts, and mark that claim as the one it
 * came from.
 *
 * ONE transaction, and it has to be: the relation's partial unique and the
 * claim's `..._selected_relation_key` are two constraints over one decision, so
 * a relation that commits without its selection leaves a published fact whose
 * provenance is a claim still marked `unresolved` — visible in a queue as work
 * nobody owes.
 *
 * Idempotent through `openCompatibilityRelation`: a repeat converges on the open
 * row and re-selects the same claim, which is a no-op update rather than a
 * second relation.
 */
export async function promoteClaimToRelation(
  claimId: string,
  relation: InsertCompatibilityRelation,
  now: Date = new Date(),
): Promise<CompatibilityRelationRow> {
  return getDb().transaction(async (tx) => {
    const claim = await findClaimById(claimId, tx);
    assertClaimMatchesSubject(
      claim,
      relation.subjectProductId ?? null,
      relation.subjectVariantId ?? null,
    );
    const opened = await openCompatibilityRelation(relation, tx);
    await selectClaim(tx, claimId, { relationId: opened.id }, now);
    return opened;
  });
}

/** The automotive half of {@link promoteClaimToRelation}, and the same reasoning. */
export async function promoteClaimToFitment(
  claimId: string,
  fitment: InsertAutomotiveFitment,
  now: Date = new Date(),
): Promise<AutomotiveFitmentRow> {
  return getDb().transaction(async (tx) => promoteClaimToFitmentWithin(tx, claimId, fitment, now));
}

/**
 * The same promotion, inside a transaction the CALLER owns.
 *
 * Split out because the operator surface has a third write to make in the same
 * breath: `/internal/catalog-governance` audits every act it performs, and an
 * audit row that commits separately from the fitment it describes is one a
 * restart can lose — leaving a published fit with no record of who published it,
 * which is the one question an incident asks about a wrong fitment. The two-write
 * reasoning in {@link promoteClaimToRelation}'s header is the same reasoning; this
 * is it with the boundary moved out one level.
 *
 * `promoteClaimToFitment` above is the standalone spelling and delegates here, so
 * there is one body and not two — the `createStoreProduct`/`createStoreProductWithin`
 * pattern.
 */
export async function promoteClaimToFitmentWithin(
  tx: DatabaseOrTransaction,
  claimId: string,
  fitment: InsertAutomotiveFitment,
  now: Date = new Date(),
): Promise<AutomotiveFitmentRow> {
  const claim = await findClaimById(claimId, tx);
  assertClaimMatchesSubject(
    claim,
    fitment.subjectProductId ?? null,
    fitment.subjectVariantId ?? null,
  );
  const opened = await openAutomotiveFitment(fitment, tx);
  await selectClaim(tx, claimId, { fitmentId: opened.id }, now);
  return opened;
}

/**
 * Refuse a promotion whose claim is about a different subject from the canonical
 * row it would create.
 *
 * Called by BOTH promotions, inside their transaction, before anything is
 * opened. It is a cheap check for an expensive mistake: promoting claim A onto
 * relation B publishes A's evidence under B's pairing, which is a false merge
 * with a provenance trail that looks complete — the worst shape a wrong answer
 * takes here, because the audit confirms it.
 *
 * Exported so `claim.service.test.ts` can drive it directly. A pure guard nobody
 * can call in isolation is a guard nobody mutation-tests.
 */
export function assertClaimMatchesSubject(
  claim: CompatibilityClaimRow | null,
  subjectProductId: string | null,
  subjectVariantId: string | null,
): void {
  if (claim === null) {
    throw conflict('no such compatibility claim');
  }
  if (claim.subjectProductId === null && claim.subjectVariantId === null) {
    throw conflict('this claim names no subject and cannot be promoted');
  }
  if (claim.subjectProductId !== subjectProductId || claim.subjectVariantId !== subjectVariantId) {
    throw conflict('this claim is about a different subject from the row it would be selected into');
  }
}
