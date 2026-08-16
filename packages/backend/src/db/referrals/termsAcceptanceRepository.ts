/**
 * Reads and writes for `referral_terms_acceptances` (#146 increment 2, "Terms
 * acceptance").
 *
 * The table is APPEND-ONLY by trigger, so there is deliberately no update and
 * no delete here — not as a convention, but because the only statements the
 * server will accept are the two below.
 *
 * Accepting the same version twice is `ON CONFLICT DO NOTHING` on the
 * NULL-folded `acceptance_key`, whose empty `RETURNING` set IS the "already
 * accepted" answer. A read-then-write would let two clicks both see "not yet"
 * — and a duplicate acceptance is not merely untidy: it would make "when did
 * this partner accept" have two answers, one of which is later than the version
 * bump it is supposed to precede.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ReferralTermsScope } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralTermsAcceptances } from '../schema/referrals.js';

/** One acceptance row as the services read it back. */
export type ReferralTermsAcceptanceRow = typeof referralTermsAcceptances.$inferSelect;

/**
 * Record one acceptance, converging on the row that already exists.
 *
 * @returns `created: false` when this exact (scope, program, version) was
 *   already accepted — an ordinary, successful outcome (#146 terms rule 4: a
 *   re-acceptance is required only when a MATERIAL new version says so).
 */
export async function insertTermsAcceptance(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    scope: ReferralTermsScope;
    programId: string | null;
    termsVersion: string;
    acceptedAt: Date;
    acceptedByOxyUserId: string;
    locale: string;
  },
): Promise<{ row: ReferralTermsAcceptanceRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralTermsAcceptances)
    .values({
      partnerId: input.partnerId,
      scope: input.scope,
      programId: input.programId,
      termsVersion: input.termsVersion,
      acceptedAt: input.acceptedAt,
      acceptedByOxyUserId: input.acceptedByOxyUserId,
      locale: input.locale,
    })
    .onConflictDoNothing({
      target: [referralTermsAcceptances.partnerId, referralTermsAcceptances.acceptanceKey],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findTermsAcceptance(db, input);
  if (!existing) {
    throw new Error(
      `referral_terms_acceptances insert for partner ${input.partnerId} conflicted with a row ` +
        'that then could not be read back.',
    );
  }
  return { row: existing, created: false };
}

/** One exact acceptance, by its natural key. */
export async function findTermsAcceptance(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    scope: ReferralTermsScope;
    programId: string | null;
    termsVersion: string;
  },
): Promise<ReferralTermsAcceptanceRow | undefined> {
  // The generated key folds the NULL, so it is compared rather than the three
  // columns — a `programId is null` predicate here would be a second, weaker
  // spelling of the index's own definition.
  const acceptanceKey = `${input.scope}|${input.programId ?? ''}|${input.termsVersion}`;
  const [row] = await db
    .select()
    .from(referralTermsAcceptances)
    .where(
      and(
        eq(referralTermsAcceptances.partnerId, input.partnerId),
        eq(referralTermsAcceptances.acceptanceKey, acceptanceKey),
      ),
    );
  return row;
}

/** Every acceptance this partner has ever made, newest first. */
export async function listTermsAcceptances(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<readonly ReferralTermsAcceptanceRow[]> {
  return await db
    .select()
    .from(referralTermsAcceptances)
    .where(eq(referralTermsAcceptances.partnerId, partnerId))
    .orderBy(desc(referralTermsAcceptances.acceptedAt), desc(referralTermsAcceptances.id));
}
