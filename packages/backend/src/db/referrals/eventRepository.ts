/**
 * Appends and reads for `referral_events` — the domain's append-only audit
 * trail. One writer function, no update, no delete: the `payment_repairs`
 * discipline.
 */

import { and, asc, eq } from 'drizzle-orm';
import type {
  ReferralEventAction,
  ReferralEventActorKind,
  ReferralEventSubjectType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralEvents } from '../schema/referrals.js';

/** An audit event row as the services read it back. */
export type ReferralEventRow = typeof referralEvents.$inferSelect;

/** The reason column's bound — the writer slices, the CHECK refuses. */
const MAX_REASON_LENGTH = 2_000;

export async function appendReferralEvent(
  db: DatabaseOrTransaction,
  input: {
    subjectType: ReferralEventSubjectType;
    subjectId: string;
    action: ReferralEventAction;
    actorKind: ReferralEventActorKind;
    actorRef?: string;
    reason: string;
  },
): Promise<ReferralEventRow> {
  const [row] = await db
    .insert(referralEvents)
    .values({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      action: input.action,
      actorKind: input.actorKind,
      actorRef: input.actorRef ?? null,
      reason: input.reason.slice(0, MAX_REASON_LENGTH),
    })
    .returning();
  if (!row) {
    throw new Error(
      `referral_events append for ${input.subjectType}:${input.subjectId} returned no row.`,
    );
  }
  return row;
}

/** A subject's audit trail, oldest first — the order a history reads in. */
export async function listReferralEvents(
  db: DatabaseOrTransaction,
  input: { subjectType: ReferralEventSubjectType; subjectId: string },
): Promise<ReferralEventRow[]> {
  return await db
    .select()
    .from(referralEvents)
    .where(
      and(
        eq(referralEvents.subjectType, input.subjectType),
        eq(referralEvents.subjectId, input.subjectId),
      ),
    )
    .orderBy(asc(referralEvents.createdAt), asc(referralEvents.id));
}
