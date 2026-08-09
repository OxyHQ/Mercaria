/**
 * The append-only audit of operator-assisted recovery (#108 recovery rule 8).
 *
 * `payment_repairs`' shape exactly: one row per ATTEMPT, a mandatory actor, a
 * mandatory reason, refusals recorded rather than swallowed. The repository
 * offers an INSERT and a read and deliberately nothing else — there is no
 * update and no delete, so the record of what staff did on a buyer's behalf
 * cannot be edited by the staff who did it.
 */

import { eq, sql } from 'drizzle-orm';
import type {
  GuestPortalOperatorAction,
  GuestPortalOperatorOutcome,
} from '@mercaria/shared-types';
import { guestPortalOperatorActions } from '../schema/guestPortal.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_portal_operator_actions` row as the backend reads it. */
export type GuestPortalOperatorActionRow = typeof guestPortalOperatorActions.$inferSelect;

/** What one audited attempt records. */
export interface RecordGuestPortalOperatorActionInput {
  checkoutGroupId: string;
  action: GuestPortalOperatorAction;
  /** The Oxy operator. Never optional — an audit with a nullable actor is not one. */
  actorOxyUserId: string;
  reason: string;
  outcome: GuestPortalOperatorOutcome;
  /** A bounded code, present exactly when the outcome is `refused` (a CHECK). */
  refusalCode?: string;
}

/** Append one attempt. */
export async function recordGuestPortalOperatorAction(
  db: DatabaseOrTransaction,
  input: RecordGuestPortalOperatorActionInput,
): Promise<GuestPortalOperatorActionRow> {
  const [row] = await db
    .insert(guestPortalOperatorActions)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      action: input.action,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      outcome: input.outcome,
      refusalCode: input.refusalCode ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('guest_portal_operator_actions insert returned no row');
  }
  return row;
}

/** Every operator attempt against one checkout group, newest first. */
export async function listGuestPortalOperatorActions(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  limit: number,
): Promise<GuestPortalOperatorActionRow[]> {
  return await db
    .select()
    .from(guestPortalOperatorActions)
    .where(eq(guestPortalOperatorActions.checkoutGroupId, checkoutGroupId))
    .orderBy(sql`${guestPortalOperatorActions.createdAt} desc`)
    .limit(limit);
}
