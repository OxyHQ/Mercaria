/**
 * Reads and writes for `referral_attributions` — immutable, append-only
 * corrected.
 *
 * The write surface is deliberately NARROW: an insert, and three named
 * transitions out of `active` (supersede, invalidate, correct), each a
 * single-statement CAS on `state = 'active'`. There is no generic `update`, so
 * "rows never rewrite their identity, evidence or pinned versions" is a
 * property of what this module can express rather than a review rule.
 *
 * The winner-cardinality unique index makes the concurrent-create race safe:
 * the loser's insert raises on `referral_attributions_active_winner_key`, which
 * {@link insertAttribution} surfaces as `null` — an ANSWER (someone else holds
 * the win) for the resolver to re-read and re-resolve, never a 500.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type {
  ReferralActorKind,
  ReferralAttributionPolicy,
  ReferralConflictReason,
  ReferralSubjectKind,
  ReferralTouchKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralAttributions } from '../schema/referrals.js';

/** An attribution row as the services read it back. */
export type ReferralAttributionRow = typeof referralAttributions.$inferSelect;

/** The (program, subject) scope the winner cardinality is enforced over. */
export interface AttributionSubjectScope {
  programId: string;
  subjectKind: ReferralSubjectKind;
  subjectRef: string;
}

/** Everything an attribution pins at creation (ADR 0005 D19). */
export interface CreateAttributionInput extends AttributionSubjectScope {
  programVersionId: string;
  partnerId: string;
  winningTouchId?: string;
  winningCodeId: string;
  evidenceTouchKind: ReferralTouchKind;
  evidenceOccurredAt: Date;
  attributionPolicy: ReferralAttributionPolicy;
  ruleVersionRef: string;
  expiresAt: Date;
  originalActorKind: ReferralActorKind;
  /** The predecessor this row supersedes or corrects, when it has one. */
  supersedesAttributionId?: string;
}

/**
 * Insert an ACTIVE attribution. `null` means the partial unique index refused
 * it — another active attribution holds this (program, subject) scope.
 */
export async function insertAttribution(
  db: DatabaseOrTransaction,
  input: CreateAttributionInput,
): Promise<ReferralAttributionRow | null> {
  try {
    const [row] = await db
      .insert(referralAttributions)
      .values({
        programId: input.programId,
        programVersionId: input.programVersionId,
        partnerId: input.partnerId,
        subjectKind: input.subjectKind,
        subjectRef: input.subjectRef,
        winningTouchId: input.winningTouchId ?? null,
        winningCodeId: input.winningCodeId,
        evidenceTouchKind: input.evidenceTouchKind,
        evidenceOccurredAt: input.evidenceOccurredAt,
        attributionPolicy: input.attributionPolicy,
        ruleVersionRef: input.ruleVersionRef,
        expiresAt: input.expiresAt,
        originalActorKind: input.originalActorKind,
        supersedesAttributionId: input.supersedesAttributionId ?? null,
      })
      .returning();
    if (!row) {
      throw new Error(
        `referral_attributions insert for ${input.subjectKind}:${input.subjectRef} returned no row.`,
      );
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'referral_attributions_active_winner_key')) return null;
    throw error;
  }
}

export async function findAttributionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralAttributionRow | undefined> {
  const [row] = await db
    .select()
    .from(referralAttributions)
    .where(eq(referralAttributions.id, id));
  return row;
}

/** The current winner for a scope, when one exists. */
export async function findActiveAttribution(
  db: DatabaseOrTransaction,
  scope: AttributionSubjectScope,
): Promise<ReferralAttributionRow | undefined> {
  const [row] = await db
    .select()
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.programId, scope.programId),
        eq(referralAttributions.subjectKind, scope.subjectKind),
        eq(referralAttributions.subjectRef, scope.subjectRef),
        eq(referralAttributions.state, 'active'),
      ),
    );
  return row;
}

/**
 * Move an ACTIVE attribution out of `active` — the ONLY mutation this table
 * has. The CAS on `state = 'active'` means a concurrent resolver that already
 * resolved this row leaves this call returning `undefined` instead of
 * double-resolving. For `superseded` and `corrected` the SUCCESSOR row names
 * this one through `supersedes_attribution_id`; nothing here points forward.
 */
export async function closeAttribution(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    to: 'superseded' | 'corrected' | 'conflicted' | 'invalidated';
    conflictReason: ReferralConflictReason;
    at: Date;
  },
): Promise<ReferralAttributionRow | undefined> {
  const [row] = await db
    .update(referralAttributions)
    .set({ state: input.to, conflictReason: input.conflictReason, resolvedAt: input.at })
    .where(and(eq(referralAttributions.id, input.id), eq(referralAttributions.state, 'active')))
    .returning();
  return row;
}

/** A partner's attributions, keyset-paginated newest first. */
export async function listAttributionsByPartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; limit: number; before?: Date },
): Promise<ReferralAttributionRow[]> {
  return await db
    .select()
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        input.before
          ? sql`${referralAttributions.createdAt} < ${input.before.toISOString()}::timestamptz`
          : undefined,
      ),
    )
    .orderBy(desc(referralAttributions.createdAt))
    .limit(input.limit);
}

/** Is this attribution still able to convert at `at`? */
export function attributionCanConvertAt(row: ReferralAttributionRow, at: Date): boolean {
  return row.state === 'active' && row.expiresAt.getTime() > at.getTime();
}

/** The subject's attribution history (operator provenance read), newest first. */
export async function listAttributionsForSubject(
  db: DatabaseOrTransaction,
  input: { subjectKind: ReferralSubjectKind; subjectRef: string; limit: number },
): Promise<ReferralAttributionRow[]> {
  return await db
    .select()
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.subjectKind, input.subjectKind),
        eq(referralAttributions.subjectRef, input.subjectRef),
      ),
    )
    .orderBy(desc(referralAttributions.createdAt))
    .limit(input.limit);
}
