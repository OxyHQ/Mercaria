/**
 * `analytics_pseudonym_salts` — the rotating secret every pseudonymous session
 * id is derived under (#77 data-lifecycle rule 7).
 *
 * ## The salt is a live secret and never leaves this module's callers
 *
 * It is in `PROTECTED_COLUMNS`, so a whole-row read cannot reach it. The one
 * legitimate consumer is `services/analytics/identity.ts`, which caches the
 * CURRENT epoch in memory and hashes with it. Nothing else has any reason to
 * hold the value, and possession of it turns every pseudonym of that epoch back
 * into the session handle it came from.
 *
 * ## Rotation is an insert plus a close, in ONE transaction
 *
 * Closing the old epoch and opening the new one apart would leave a window with
 * either two current epochs (the partial unique refuses it) or none (the
 * derivation would have nothing to hash with). The transaction is what makes
 * the invariant the index states reachable in the first place.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../postgres.js';
import { analyticsPseudonymSalts } from '../schema/analytics.js';

/** The current epoch, as the derivation needs it. */
export interface AnalyticsPseudonymSalt {
  readonly epoch: number;
  readonly salt: string;
  readonly activeFrom: Date;
}

/**
 * Read the epoch currently in force.
 *
 * The select names every column explicitly, including the protected `salt` —
 * this is the ONE opt-in the registry's rule asks for, and it reads differently
 * from an ordinary select on purpose.
 *
 * @returns The current epoch, or `undefined` when none has been opened yet.
 */
export async function readCurrentSalt(): Promise<AnalyticsPseudonymSalt | undefined> {
  const rows = await getDb()
    .select({
      epoch: analyticsPseudonymSalts.epoch,
      salt: analyticsPseudonymSalts.salt,
      activeFrom: analyticsPseudonymSalts.activeFrom,
    })
    .from(analyticsPseudonymSalts)
    .where(isNull(analyticsPseudonymSalts.activeUntil))
    .limit(1);
  return rows[0];
}

/**
 * Open a new epoch, closing the current one in the same transaction.
 *
 * Idempotent under a race by the partial unique
 * `analytics_pseudonym_salts_current_key`: two tasks rotating at once produce
 * one winner and one constraint violation, and the loser re-reads. That is
 * deliberately NOT swallowed here — the caller decides, because a rotation that
 * silently no-ops is indistinguishable from one that never ran.
 *
 * @param salt The new secret. 32 CSPRNG bytes, hex, minted by the caller.
 * @param expiresAt When the RETIRED epoch's row is deleted by the expiry sweep.
 */
export async function rotateSalt(input: {
  salt: string;
  now: Date;
  expiresAt: Date;
}): Promise<AnalyticsPseudonymSalt> {
  return getDb().transaction(async (tx) => {
    // `FOR UPDATE` on the open epoch first: two rotations racing must serialize
    // on the row they are both closing rather than on the unique index, so the
    // loser waits and then finds nothing to close instead of raising.
    const current = await tx
      .select({ id: analyticsPseudonymSalts.id, epoch: analyticsPseudonymSalts.epoch })
      .from(analyticsPseudonymSalts)
      .where(isNull(analyticsPseudonymSalts.activeUntil))
      .for('update')
      .limit(1);

    const previous = current[0];
    if (previous) {
      await tx
        .update(analyticsPseudonymSalts)
        .set({ activeUntil: input.now })
        .where(
          and(
            eq(analyticsPseudonymSalts.id, previous.id),
            isNull(analyticsPseudonymSalts.activeUntil),
          ),
        );
    }

    const nextEpoch = (previous?.epoch ?? 0) + 1;
    const inserted = await tx
      .insert(analyticsPseudonymSalts)
      .values({
        epoch: nextEpoch,
        salt: input.salt,
        activeFrom: input.now,
        expiresAt: input.expiresAt,
      })
      .returning({
        epoch: analyticsPseudonymSalts.epoch,
        salt: analyticsPseudonymSalts.salt,
        activeFrom: analyticsPseudonymSalts.activeFrom,
      });

    const row = inserted[0];
    if (!row) {
      // Unreachable with a `RETURNING` on a single-row insert; the branch exists
      // because the alternative is a non-null assertion, which this codebase
      // does not use.
      throw new Error('Rotating the analytics pseudonym salt returned no row');
    }
    return row;
  });
}

/**
 * How many epochs are past their deletion deadline but still present.
 *
 * The operator surface reads this, and it must be zero on a healthy deployment
 * — an un-swept salt is the one thing that could make a "rotated" pseudonym
 * re-identifiable after the fact.
 */
export async function countOverdueSalts(now: Date): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(analyticsPseudonymSalts)
    .where(sql`${analyticsPseudonymSalts.expiresAt} < ${now}`);
  return Number(rows[0]?.total ?? 0);
}
