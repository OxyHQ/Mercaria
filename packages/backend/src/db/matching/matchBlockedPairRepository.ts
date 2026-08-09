/**
 * `match_blocked_pairs` — the negative link (#58 match record 10, acceptance 4).
 *
 * Reads, one insert and one clear. There is deliberately no UPDATE that changes
 * what a block MEANS and no DELETE at all: a rejection is a person's judgement
 * about a pair, and rewriting or erasing one leaves a catalogue whose corrections
 * cannot be audited. Clearing appends the actor and the reason to the same row,
 * so "who un-rejected this, and why" is answerable forever.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MatchSubjectKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { matchBlockedPairs } from '../schema/matching.js';

export type MatchBlockedPairRow = typeof matchBlockedPairs.$inferSelect;

export interface BlockPairInput {
  readonly subjectKey: string;
  readonly subjectKind: MatchSubjectKind;
  readonly targetCanonicalProductId: string | null;
  readonly targetCanonicalVariantId: string | null;
  readonly decisionId: string | null;
  readonly blockedUnderPolicyVersionId: string;
  readonly blockedByOxyUserId: string;
  readonly reason: string;
}

/**
 * Record a rejection.
 *
 * `ON CONFLICT DO NOTHING` against the OPEN-block partial unique, so blocking a
 * pair twice is a genuine no-op rather than a second row or an error — an
 * operator re-rejecting something already rejected has changed nothing, and the
 * first person's reason is the one that stands.
 *
 * The partial unique's predicate is repeated in the conflict target, because
 * Postgres refuses to infer a partial index as an arbiter without it (the
 * `carts` lesson, ADR 0003) — an omitted predicate is not a weaker check, it is
 * a failed statement.
 *
 * @returns The row when this call created it, `undefined` when one was already open.
 */
export async function blockPair(
  db: DatabaseOrTransaction,
  input: BlockPairInput,
): Promise<MatchBlockedPairRow | undefined> {
  const rows = await db
    .insert(matchBlockedPairs)
    .values({
      subjectKey: input.subjectKey,
      subjectKind: input.subjectKind,
      targetCanonicalProductId: input.targetCanonicalProductId,
      targetCanonicalVariantId: input.targetCanonicalVariantId,
      decisionId: input.decisionId,
      blockedUnderPolicyVersionId: input.blockedUnderPolicyVersionId,
      blockedByOxyUserId: input.blockedByOxyUserId,
      reason: input.reason,
    })
    .onConflictDoNothing({
      target: [matchBlockedPairs.subjectKey, matchBlockedPairs.targetKey],
      where: isNull(matchBlockedPairs.clearedAt),
    })
    .returning();
  return rows[0];
}

/**
 * Lift a rejection.
 *
 * A one-statement CAS on `cleared_at IS NULL`, so a concurrent second clear
 * writes nothing and the first actor and reason are the recorded ones.
 */
export async function clearBlockedPair(
  db: DatabaseOrTransaction,
  input: { id: string; clearedByOxyUserId: string; reason: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(matchBlockedPairs)
    .set({
      clearedAt: input.now,
      clearedByOxyUserId: input.clearedByOxyUserId,
      clearReason: input.reason,
    })
    .where(and(eq(matchBlockedPairs.id, input.id), isNull(matchBlockedPairs.clearedAt)))
    .returning({ id: matchBlockedPairs.id });
  return rows.length === 1;
}

/** Every OPEN block for one subject — what the pipeline reads on every run. */
export async function listOpenBlocksForSubject(
  db: DatabaseOrTransaction,
  subjectKey: string,
): Promise<MatchBlockedPairRow[]> {
  return db
    .select()
    .from(matchBlockedPairs)
    .where(
      and(eq(matchBlockedPairs.subjectKey, subjectKey), isNull(matchBlockedPairs.clearedAt)),
    );
}

/** Every block for one subject, cleared ones included — the operator trace. */
export async function listBlocksForSubject(
  db: DatabaseOrTransaction,
  subjectKey: string,
): Promise<MatchBlockedPairRow[]> {
  return db
    .select()
    .from(matchBlockedPairs)
    .where(eq(matchBlockedPairs.subjectKey, subjectKey))
    .orderBy(matchBlockedPairs.createdAt);
}

export async function findBlockedPairById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MatchBlockedPairRow | undefined> {
  const rows = await db
    .select()
    .from(matchBlockedPairs)
    .where(eq(matchBlockedPairs.id, id))
    .limit(1);
  return rows[0];
}

export async function countOpenBlockedPairs(db: DatabaseOrTransaction): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(matchBlockedPairs)
    .where(isNull(matchBlockedPairs.clearedAt));
  return rows[0]?.total ?? 0;
}
