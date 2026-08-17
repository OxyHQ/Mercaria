/**
 * `compatibility_claims` — what a source said, before Mercaria decided anything
 * about it (#367 step 8, ADR 0007 D7).
 *
 * Two facts about this table shape every function here:
 *
 * - **An unresolved claim is stored, not discarded.** The reads below are
 *   mostly about that set: `countUnresolvedBySource` is the number an operator
 *   uses to tell an unmappable feed from an unmapped one, and it comes off the
 *   partial index rather than a scan of the table.
 * - **Selection is a state change, never an overwrite.** `selectClaim` moves
 *   ONE claim to `selected` and points it at the canonical row; the previous
 *   selection becomes `superseded` and stays. There is no update path that
 *   rewrites `raw_target_text`, and no delete at all — a claim Mercaria could
 *   not read is the only record that a source said something, and deleting it
 *   makes the next import look like the first.
 */

import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  CompatibilityClaimState,
  CompatibilitySubject,
  CompatibilityUnresolvedReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { compatibilityClaims } from '../schema/compatibility.js';

export type CompatibilityClaimRow = typeof compatibilityClaims.$inferSelect;
export type InsertCompatibilityClaim = typeof compatibilityClaims.$inferInsert;

/** Record a claim exactly as the source made it. */
export async function insertCompatibilityClaim(
  values: InsertCompatibilityClaim,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow> {
  const [row] = await db.insert(compatibilityClaims).values(values).returning();
  if (row === undefined) {
    throw new Error('insertCompatibilityClaim returned no row');
  }
  return row;
}

export async function findClaimById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow | null> {
  const [row] = await db
    .select()
    .from(compatibilityClaims)
    .where(eq(compatibilityClaims.id, id))
    .limit(1);
  return row ?? null;
}

/** Every claim behind one canonical relation — the provenance trail (D7). */
export async function listClaimsForRelation(
  relationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow[]> {
  return db
    .select()
    .from(compatibilityClaims)
    .where(eq(compatibilityClaims.relationId, relationId))
    .orderBy(desc(compatibilityClaims.observedAt), compatibilityClaims.id);
}

/** Every claim behind one fitment. */
export async function listClaimsForFitment(
  fitmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow[]> {
  return db
    .select()
    .from(compatibilityClaims)
    .where(eq(compatibilityClaims.fitmentId, fitmentId))
    .orderBy(desc(compatibilityClaims.observedAt), compatibilityClaims.id);
}

/** Every claim about one subject, resolved or not — the seller-facing trail. */
export async function listClaimsForSubject(
  subject: CompatibilitySubject,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow[]> {
  const clause =
    subject.kind === 'canonical_product'
      ? eq(compatibilityClaims.subjectProductId, subject.productId)
      : eq(compatibilityClaims.subjectVariantId, subject.variantId);
  return db
    .select()
    .from(compatibilityClaims)
    .where(clause)
    .orderBy(desc(compatibilityClaims.observedAt), compatibilityClaims.id);
}

/** The unresolved review queue, oldest first, optionally scoped to one source. */
export async function listUnresolvedClaims(
  sourceId: string | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityClaimRow[]> {
  const clauses = [eq(compatibilityClaims.state, 'unresolved')];
  if (sourceId !== null) {
    clauses.push(eq(compatibilityClaims.assertedBySourceId, sourceId));
  }
  return db
    .select()
    .from(compatibilityClaims)
    .where(and(...clauses))
    .orderBy(compatibilityClaims.createdAt, compatibilityClaims.id)
    .limit(limit < 1 ? 1 : limit);
}

/**
 * How many claims a source has made that Mercaria could not resolve, BY REASON.
 *
 * The breakdown is the point rather than the total: `unknown_target` at scale
 * means the vehicle tree is missing rows somebody can import, and
 * `unparsed_target` at the same scale means the feed's format changed and no
 * amount of reference data will help. One number cannot tell those apart, and
 * they lead to opposite work.
 *
 * The count is honest about zero: a source with no unresolved claims returns an
 * EMPTY array, not a row of zeroes, and the caller renders "none" rather than
 * reading an absent key as a measurement.
 */
export interface UnresolvedClaimCount {
  readonly reason: CompatibilityUnresolvedReason;
  readonly count: number;
}

export async function countUnresolvedBySource(
  /**
   * `null` counts EVERY source, which is what an operator queue needs before it
   * knows which source to blame. Widened to match `listUnresolvedClaims`, whose
   * `sourceId` has always been nullable — the two are read together and a
   * breakdown that could only ever be per-source made the unscoped list
   * impossible to characterise.
   */
  sourceId: string | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<UnresolvedClaimCount[]> {
  const clauses = [eq(compatibilityClaims.state, 'unresolved')];
  if (sourceId !== null) {
    clauses.push(eq(compatibilityClaims.assertedBySourceId, sourceId));
  }
  const rows = await db
    .select({ reason: compatibilityClaims.unresolvedReason, total: count() })
    .from(compatibilityClaims)
    .where(and(...clauses))
    .groupBy(compatibilityClaims.unresolvedReason);
  const counts: UnresolvedClaimCount[] = [];
  for (const row of rows) {
    // `unresolved_reason` is NOT NULL on an unresolved row by CHECK, so this
    // branch is unreachable — and it is written rather than asserted away with
    // `!`, because a CHECK the reader cannot see is not a licence to lie to the
    // compiler.
    if (row.reason === null) continue;
    counts.push({ reason: row.reason, count: Number(row.total) });
  }
  return counts;
}

/**
 * Move ONE claim to `selected` against a canonical row, superseding whichever
 * claim held that place.
 *
 * Both statements run in the CALLER's transaction handle, deliberately: the
 * partial unique `compatibility_claims_selected_relation_key` holds at most one
 * selected claim per relation, so a supersede and a select that do not commit
 * together leave either two selections refused by the index or none at all.
 * Taking the handle rather than opening one is the `enqueueOfferConvergence`
 * posture — the caller owns the boundary because the caller is usually already
 * inside one that also wrote the canonical row.
 */
export async function selectClaim(
  db: DatabaseOrTransaction,
  claimId: string,
  target: { readonly relationId: string } | { readonly fitmentId: string },
  now: Date,
): Promise<void> {
  const scope =
    'relationId' in target
      ? eq(compatibilityClaims.relationId, target.relationId)
      : eq(compatibilityClaims.fitmentId, target.fitmentId);

  await db
    .update(compatibilityClaims)
    .set({ state: 'superseded', updatedAt: now })
    .where(and(scope, eq(compatibilityClaims.state, 'selected'), sql`${compatibilityClaims.id} <> ${claimId}`));

  await db
    .update(compatibilityClaims)
    .set({
      state: 'selected',
      unresolvedReason: null,
      relationId: 'relationId' in target ? target.relationId : null,
      fitmentId: 'fitmentId' in target ? target.fitmentId : null,
      updatedAt: now,
    })
    .where(eq(compatibilityClaims.id, claimId));
}

/**
 * Record an operator's judgement on a claim.
 *
 * `rejected` requires the actor and the instant — the row's own CHECK says so,
 * and this signature is what makes the CHECK unreachable rather than a runtime
 * surprise: there is no parameter list that omits them.
 */
export async function recordClaimReview(
  claimId: string,
  state: CompatibilityClaimState,
  actorOxyUserId: string,
  reviewedAt: Date,
  reviewNote: string | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(compatibilityClaims)
    .set({ state, reviewedByOxyUserId: actorOxyUserId, reviewedAt, reviewNote, updatedAt: reviewedAt })
    .where(eq(compatibilityClaims.id, claimId))
    .returning({ id: compatibilityClaims.id });
  return updated.length === 1;
}

/** Claims a source made that have never been looked at. Used by the metrics read. */
export async function countUnreviewedClaims(
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(compatibilityClaims)
    .where(and(eq(compatibilityClaims.state, 'unresolved'), isNull(compatibilityClaims.reviewedAt)));
  return row === undefined ? 0 : Number(row.total);
}
