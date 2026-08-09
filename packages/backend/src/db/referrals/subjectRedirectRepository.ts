/**
 * Reads and writes for `referral_subject_redirects` — identity merges as
 * redirects (issue #142, identity/uniqueness 6).
 *
 * History is never rewritten: an attribution keeps the subject reference it
 * was created with, and reads resolve through this table. The chain walk is
 * bounded and cycle-safe — a redirect graph an operator managed to knot must
 * fail loudly, not loop a request forever.
 */

import { and, eq } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type { ReferralEventActorKind, ReferralSubjectKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralSubjectRedirects } from '../schema/referrals.js';

/** A redirect row as the services read it back. */
export type ReferralSubjectRedirectRow = typeof referralSubjectRedirects.$inferSelect;

/** How many hops a redirect chain may take before it is declared broken. */
const MAX_REDIRECT_DEPTH = 10;

/**
 * Record a merge redirect. `null` means `from_ref` already redirects somewhere
 * — one reference redirects to exactly one place, and a second merge naming it
 * is the caller's conflict to report.
 */
export async function insertSubjectRedirect(
  db: DatabaseOrTransaction,
  input: {
    subjectKind: ReferralSubjectKind;
    fromRef: string;
    toRef: string;
    actorKind: ReferralEventActorKind;
    actorRef?: string;
    reason: string;
  },
): Promise<ReferralSubjectRedirectRow | null> {
  try {
    const [row] = await db
      .insert(referralSubjectRedirects)
      .values({
        subjectKind: input.subjectKind,
        fromRef: input.fromRef,
        toRef: input.toRef,
        actorKind: input.actorKind,
        actorRef: input.actorRef ?? null,
        reason: input.reason,
      })
      .returning();
    if (!row) {
      throw new Error(
        `referral_subject_redirects insert for ${input.subjectKind}:${input.fromRef} returned no row.`,
      );
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'referral_subject_redirects_from_key')) return null;
    throw error;
  }
}

/**
 * Follow the redirect chain from `ref` to its canonical end.
 *
 * @throws When the chain exceeds {@link MAX_REDIRECT_DEPTH} — a knot is data
 *   corruption to surface, never something to walk forever.
 */
export async function resolveSubjectRef(
  db: DatabaseOrTransaction,
  subjectKind: ReferralSubjectKind,
  ref: string,
): Promise<string> {
  let current = ref;
  for (let hop = 0; hop < MAX_REDIRECT_DEPTH; hop += 1) {
    const [row] = await db
      .select({ toRef: referralSubjectRedirects.toRef })
      .from(referralSubjectRedirects)
      .where(
        and(
          eq(referralSubjectRedirects.subjectKind, subjectKind),
          eq(referralSubjectRedirects.fromRef, current),
        ),
      );
    if (row === undefined) return current;
    current = row.toRef;
  }
  throw new Error(
    `Referral subject redirect chain for ${subjectKind}:${ref} exceeds ${MAX_REDIRECT_DEPTH} hops — ` +
      'the redirect data is knotted and must be repaired by an operator.',
  );
}
