/**
 * Reads and writes on `guest_order_claim_revocations` (#109 revocation rules
 * 3 and 4).
 *
 * Three writes and no fourth: request, approve-and-execute, withdraw. Each
 * transition is guarded on the state it leaves, so a duplicate approval moves
 * nothing and the caller reads the empty result as convergence rather than as
 * a failure.
 *
 * There is no DELETE. A withdrawn request is the record that an operator
 * considered detaching somebody's purchase and decided not to, which is exactly
 * the kind of thing a correction audit exists to hold.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { GuestClaimRevocationReason } from '@mercaria/shared-types';
import { guestOrderClaimRevocations } from '../schema/guestClaims.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_order_claim_revocations` row as the backend reads it. */
export type GuestClaimRevocationRow = typeof guestOrderClaimRevocations.$inferSelect;

/**
 * Open a revocation request, or lose to one already open.
 *
 * `ON CONFLICT DO NOTHING` on the partial unique — an empty result means
 * another operator already opened one for this claim, and the caller reads that
 * one back rather than creating a rival. Two operators reaching the same
 * conclusion converge on one record, which is what stops a claim being detached
 * twice by two approvals of two requests.
 */
export async function insertRevocationRequest(
  db: DatabaseOrTransaction,
  input: {
    claimId: string;
    reason: GuestClaimRevocationReason;
    evidenceRef: string;
    requestedByOxyUserId: string;
    fourEyesRequired: boolean;
  },
): Promise<GuestClaimRevocationRow | null> {
  const rows = await db
    .insert(guestOrderClaimRevocations)
    .values({
      claimId: input.claimId,
      state: 'pending_approval',
      reason: input.reason,
      evidenceRef: input.evidenceRef,
      requestedByOxyUserId: input.requestedByOxyUserId,
      fourEyesRequired: input.fourEyesRequired,
    })
    // `where` REPEATS the partial index's predicate — see `claimRepository.ts`
    // for why Postgres refuses to infer a partial arbiter without it.
    .onConflictDoNothing({
      target: guestOrderClaimRevocations.claimId,
      where: eq(guestOrderClaimRevocations.state, 'pending_approval'),
    })
    .returning();
  return rows[0] ?? null;
}

/** One revocation by id, whatever its state. */
export async function findRevocationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<GuestClaimRevocationRow | null> {
  const [row] = await db
    .select()
    .from(guestOrderClaimRevocations)
    .where(eq(guestOrderClaimRevocations.id, id))
    .limit(1);
  return row ?? null;
}

/** The open request for a claim, if one is standing. */
export async function findOpenRevocationForClaim(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<GuestClaimRevocationRow | null> {
  const [row] = await db
    .select()
    .from(guestOrderClaimRevocations)
    .where(
      and(
        eq(guestOrderClaimRevocations.claimId, claimId),
        eq(guestOrderClaimRevocations.state, 'pending_approval'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Approve and execute — one statement, guarded on `pending_approval`.
 *
 * The approver is written in the SAME update that moves the state, so there is
 * no instant at which a request is approved and not yet executed. That matters
 * because such an instant would be a state a second operator could approve
 * again, and the row's own CHECK (`approved_by <> requested_by`) is what makes
 * self-approval unrepresentable rather than merely refused above.
 *
 * `approvedByOxyUserId` is written even when four eyes is off, because the
 * question "who authorised this" always has an answer and it is not always the
 * requester — an operator may request today and approve tomorrow with the flag
 * off, and a NULL there would lose that.
 */
export async function markRevocationExecuted(
  db: DatabaseOrTransaction,
  input: { revocationId: string; approvedByOxyUserId: string; now: Date },
): Promise<GuestClaimRevocationRow | null> {
  const rows = await db
    .update(guestOrderClaimRevocations)
    .set({
      state: 'executed',
      approvedByOxyUserId: input.approvedByOxyUserId,
      executedAt: input.now,
    })
    .where(
      and(
        eq(guestOrderClaimRevocations.id, input.revocationId),
        eq(guestOrderClaimRevocations.state, 'pending_approval'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Withdraw an open request. Attributable, and it keeps the reason it was opened with. */
export async function markRevocationWithdrawn(
  db: DatabaseOrTransaction,
  input: { revocationId: string; withdrawnByOxyUserId: string; now: Date },
): Promise<GuestClaimRevocationRow | null> {
  const rows = await db
    .update(guestOrderClaimRevocations)
    .set({
      state: 'withdrawn',
      withdrawnAt: input.now,
      withdrawnByOxyUserId: input.withdrawnByOxyUserId,
    })
    .where(
      and(
        eq(guestOrderClaimRevocations.id, input.revocationId),
        eq(guestOrderClaimRevocations.state, 'pending_approval'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Every revocation recorded against a set of claims, newest first — the trace.
 *
 * The empty-list early return is not defensive tidiness: drizzle renders
 * `inArray(col, [])` as a constant-false predicate, which is the right answer
 * here but is one of the shapes that reads as "nothing found" when it means
 * "nothing asked". Returning early says which.
 */
export async function listRevocationsForClaims(
  db: DatabaseOrTransaction,
  claimIds: readonly string[],
  limit: number,
): Promise<GuestClaimRevocationRow[]> {
  if (claimIds.length === 0) return [];
  return await db
    .select()
    .from(guestOrderClaimRevocations)
    .where(inArray(guestOrderClaimRevocations.claimId, [...claimIds]))
    .orderBy(desc(guestOrderClaimRevocations.createdAt))
    .limit(limit);
}
