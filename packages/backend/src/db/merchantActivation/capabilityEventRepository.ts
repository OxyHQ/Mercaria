/**
 * `merchant_activation_capability_events` — the append-only trail of what each
 * capability was observed to be (#85 security 10, readiness-change rule 8).
 *
 * ## It is a RECORDING and never an authority
 *
 * Nothing that decides anything reads these rows. The verdict is derived at read
 * time from eleven tables; this says what the derivation said when somebody last
 * looked, which is the `payment_discrepancies` and `price_signal_evaluations`
 * posture. `merchant-activation-isolation.test.ts` fails the build if a
 * derivation or a gate starts selecting from it — a cached "granted" survives
 * exactly the Stripe restriction that should have withdrawn it.
 *
 * ## "What is it now" is the LATEST ROW
 *
 * There is deliberately no current-state table beside this one. A second table
 * holding the current value would be derivable from this one and could therefore
 * disagree with it, which is the failure every one-verdict rule in this
 * repository exists to prevent. `distinct on` over the index the schema declares
 * is what makes the read cheap.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  MerchantActivationActorKind,
  MerchantActivationCause,
  MerchantActivationRequirementKey,
  MerchantCapability,
  MerchantCapabilityState,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { getDb } from '../postgres.js';
import { merchantActivationCapabilityEvents } from '../schema/merchantActivation.js';

export type MerchantActivationCapabilityEventRow =
  typeof merchantActivationCapabilityEvents.$inferSelect;

/** One transition to record. */
export interface NewMerchantActivationCapabilityEvent {
  storeId: string;
  capability: MerchantCapability;
  previousState: MerchantCapabilityState | null;
  nextState: MerchantCapabilityState;
  unmet: readonly MerchantActivationRequirementKey[];
  actorKind: MerchantActivationActorKind;
  actorOxyUserId: string | null;
  cause: MerchantActivationCause;
}

/**
 * Append transitions.
 *
 * Takes a TRANSACTION handle and no default, because the caller must already
 * hold `FOR UPDATE` on the store's settings row — that lock is what serializes
 * observation, and a writer that could reach the root connection would bypass it
 * silently. The `requireTransaction` guard one domain over exists for the same
 * reason; here the signature carries it, since every caller in this domain is in
 * the same file.
 */
export async function insertCapabilityEvents(
  tx: DatabaseOrTransaction,
  events: readonly NewMerchantActivationCapabilityEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await tx
    .insert(merchantActivationCapabilityEvents)
    .values(events.map((event) => ({ ...event, unmet: [...event.unmet] })))
    .returning({ id: merchantActivationCapabilityEvents.id });
  return rows.length;
}

/**
 * The last observed state of every capability for one store.
 *
 * `distinct on (capability)` ordered by `created_at desc, id desc`. The id
 * tiebreak is load-bearing rather than defensive: one observation writes several
 * rows in one statement, so they share an instant — and `@oxyhq/db`'s uuid v7 is
 * not monotonic within a millisecond, which is why the ORDER is `id desc` and the
 * comparison never assumes a later row sorts later by key alone.
 */
export async function readLatestCapabilityStates(
  tx: DatabaseOrTransaction,
  storeId: string,
): Promise<Map<MerchantCapability, MerchantCapabilityState>> {
  const rows = await tx
    .select({
      capability: merchantActivationCapabilityEvents.capability,
      nextState: merchantActivationCapabilityEvents.nextState,
    })
    .from(merchantActivationCapabilityEvents)
    .where(eq(merchantActivationCapabilityEvents.storeId, storeId))
    .orderBy(
      merchantActivationCapabilityEvents.capability,
      desc(merchantActivationCapabilityEvents.createdAt),
      desc(merchantActivationCapabilityEvents.id),
    );

  const latest = new Map<MerchantCapability, MerchantCapabilityState>();
  for (const row of rows) {
    if (!latest.has(row.capability)) latest.set(row.capability, row.nextState);
  }
  return latest;
}

/**
 * One store's transition history, newest first — the operator trace.
 *
 * Bounded by the caller. There is no filter by actor and no filter by account:
 * "which stores did this person change" is not a question this repository can be
 * asked, because no function here takes an oxy user id.
 */
export async function listCapabilityEvents(
  storeId: string,
  limit: number,
): Promise<readonly MerchantActivationCapabilityEventRow[]> {
  return getDb()
    .select()
    .from(merchantActivationCapabilityEvents)
    .where(eq(merchantActivationCapabilityEvents.storeId, storeId))
    .orderBy(
      desc(merchantActivationCapabilityEvents.createdAt),
      desc(merchantActivationCapabilityEvents.id),
    )
    .limit(limit);
}

/**
 * How many transitions this store has recorded for one capability.
 *
 * The vacuity floor a test needs: an observation that recorded nothing and an
 * observation that never ran produce the same empty history, so a case asserting
 * "nothing changed" has to be able to show that something was recorded at all.
 */
export async function countCapabilityEvents(
  storeId: string,
  capability: MerchantCapability,
): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(merchantActivationCapabilityEvents)
    .where(
      and(
        eq(merchantActivationCapabilityEvents.storeId, storeId),
        eq(merchantActivationCapabilityEvents.capability, capability),
      ),
    );
  return row?.total ?? 0;
}
