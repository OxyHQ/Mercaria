/**
 * Reads and writes on `guest_contact_suppressions` (#108 privacy rule 5).
 *
 * Every operation takes the keyed email HASH and never an address: this module
 * cannot say which inbox it is talking about, which is exactly what makes a
 * leak of the suppression list disclose no addresses.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { GuestContactSuppressionReason } from '@mercaria/shared-types';
import { guestContactSuppressions } from '../schema/guestPortal.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_contact_suppressions` row as the backend reads it. */
export type GuestContactSuppressionRow = typeof guestContactSuppressions.$inferSelect;

/** The LIVE suppression on an inbox, if there is one. */
export async function findLiveSuppression(
  db: DatabaseOrTransaction,
  emailHash: string,
): Promise<Pick<GuestContactSuppressionRow, 'id' | 'reason' | 'createdAt'> | null> {
  const [row] = await db
    .select({
      id: guestContactSuppressions.id,
      reason: guestContactSuppressions.reason,
      createdAt: guestContactSuppressions.createdAt,
    })
    .from(guestContactSuppressions)
    .where(
      and(
        eq(guestContactSuppressions.emailHash, emailHash),
        isNull(guestContactSuppressions.liftedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Suppress an inbox, or converge on the suppression already there.
 *
 * `ON CONFLICT DO NOTHING` against the PARTIAL unique
 * (`WHERE lifted_at IS NULL`), so two workers reacting to the same hard bounce
 * converge on one row rather than racing. The partial predicate must be
 * repeated in the conflict target or Postgres cannot infer the arbiter — the
 * `carts` lesson from #104, one domain over.
 *
 * Deliberately does NOT update the reason of an existing suppression: the first
 * reason is why it started, and a later complaint on an already-bouncing
 * address does not rewrite that history.
 */
export async function suppressGuestContact(
  db: DatabaseOrTransaction,
  input: { emailHash: string; reason: GuestContactSuppressionReason },
): Promise<boolean> {
  const rows = await db
    .insert(guestContactSuppressions)
    .values({ emailHash: input.emailHash, reason: input.reason })
    .onConflictDoNothing({
      target: guestContactSuppressions.emailHash,
      where: isNull(guestContactSuppressions.liftedAt),
    })
    .returning({ id: guestContactSuppressions.id });
  return rows.length > 0;
}

/**
 * Lift a suppression — attributable, dated and explained, or refused.
 *
 * The three columns move together because a CHECK says so; passing them
 * separately is not possible from here, which is the point. A lift is the only
 * way an address starts receiving mail again: nothing expires, because a hard
 * bounce does not heal on a schedule and a person who complained did not
 * consent again by waiting.
 */
export async function liftGuestContactSuppression(
  db: DatabaseOrTransaction,
  input: { emailHash: string; actorOxyUserId: string; reason: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(guestContactSuppressions)
    .set({
      liftedAt: input.now,
      liftedByOxyUserId: input.actorOxyUserId,
      liftReason: input.reason,
    })
    .where(
      and(
        eq(guestContactSuppressions.emailHash, input.emailHash),
        isNull(guestContactSuppressions.liftedAt),
      ),
    )
    .returning({ id: guestContactSuppressions.id });
  return rows.length > 0;
}
