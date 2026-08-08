/**
 * `moderation_events` — the webhook dedupe claim, shared across tasks.
 *
 * `@oxyhq/crowdsource-express` defaults to an IN-PROCESS store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the OTHER instance is not deduplicated.
 * Mercaria's API runs several ECS Fargate tasks behind one ALB, so that is the
 * normal case rather than a hypothetical.
 *
 * ## The INSERT is the claim
 *
 * `id` is the CrowdSource event id and it is the primary key, so a conflict is not
 * an error condition to work around — it is the answer "somebody else has this
 * event". Under Mongo that answer arrived as a duplicate-key ERROR (`code 11000`)
 * which had to be recognised by inspecting an exception and separated from every
 * other failure. `ON CONFLICT (id) DO NOTHING … RETURNING` gives it as a VALUE
 * instead, so the two are no longer told apart by classifying a throw.
 *
 * That is the load-bearing difference, not a tidier spelling. A lost connection, a
 * failover or a pool exhaustion is NOT "already processed": it has to propagate so
 * the middleware answers non-2xx and the event stays on CrowdSource's retry
 * schedule. Swallowing it would answer 200 and retire a decision nobody ever
 * handled — the one failure this whole store exists to prevent — and the Mongo
 * shape made that one mis-widened `catch` away. Here there is no catch to widen:
 * the duplicate never throws, and everything that does throw reaches the caller.
 *
 * A claim is released by DELETING the row, not by marking it failed — see
 * `releaseModerationEvent`.
 */

import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { moderationEvents } from '../schema/moderation.js';

/**
 * Take the claim on an event id.
 *
 * @returns `true` when THIS call took it, `false` when it was already held. A
 *   thrown error is neither: it means the store could not answer, and the caller
 *   must let it propagate rather than read it as "already processed".
 */
export async function claimModerationEvent(
  eventId: string,
  eventType: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();
  const inserted = await db
    .insert(moderationEvents)
    .values({
      id: eventId,
      eventType,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_SECONDS.moderationEvent * 1_000),
    })
    .onConflictDoNothing({ target: moderationEvents.id })
    .returning({ id: moderationEvents.id });

  return inserted.length === 1;
}

/**
 * Give the claim back so a redelivery can be processed.
 *
 * Called when the handler THROWS. Recording an id and never releasing it would
 * make a transient failure permanent and lose a decision silently — which is why
 * this DELETES rather than marking the row failed, and why the table has no
 * `completed_at` for it to write instead.
 */
export async function releaseModerationEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEvents).where(eq(moderationEvents.id, eventId));
}
