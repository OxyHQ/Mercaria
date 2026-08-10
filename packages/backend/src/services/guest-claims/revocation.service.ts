/**
 * Detaching a claim — the audited compensating operation (#109 revocation).
 *
 * ## A claimant cannot detach their own orders, and that is a DECISION
 *
 * #109 revocation rule 2 asks the question directly ("define whether a claimant
 * can detach orders while preserving guest portal access") and the answer here
 * is no, for a reason that is about the attack rather than about tidiness.
 * Detaching is the value → NULL half of an ownership MOVE. Give it to
 * self-service and somebody who briefly held a claim — through a stolen link, a
 * shared inbox, a device somebody forgot to sign out of — can erase the trail
 * and let the group be claimed again, with no operator ever seeing that
 * ownership changed hands. Rule 1 forbids exactly that move; permitting half of
 * it self-service permits all of it in two steps.
 *
 * What a claimant loses by this is nothing they need: the orders are their own
 * purchase record, and an account that no longer wants to see them is asking a
 * display question rather than an ownership one. What they GAIN is that nobody
 * can quietly take the purchase away from them either.
 *
 * ## Two operators, two REQUESTS
 *
 * A request records the reason and an evidence reference; a DIFFERENT operator
 * approves, and the approval is what executes. Two calls rather than one naming
 * a second id, because one person can type two ids — the same reason #55 holds
 * four eyes with a review ROW rather than a comparison.
 *
 * `four_eyes_required` is snapshotted onto the request at open time, so
 * flipping the flag can neither retroactively unapprove an executed correction
 * nor silently approve a pending one (#59's `catalog_merge_jobs` device).
 *
 * ## What a revocation does NOT touch
 *
 * Seller fulfilment access, the orders' financial history, the payments, the
 * refunds, the shipping snapshots, the `buyer_origin`, the guest contact record
 * and every prior claim event — none of them moves (#109 revocation rules 6 and
 * 7). The whole of the effect is `claimed_by_oxy_user_id` and `claimed_at`
 * returning to NULL and the claim row moving to `revoked`, which is why order
 * access follows immediately with nothing to keep in step: `authorizeOrderAccess`
 * derives from the same pair.
 */

import type { GuestClaimRevocationReason } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveClaimForGroupForUpdate,
  findClaimById,
  markClaimRevoked,
  type GuestOrderClaimRow,
} from '../../db/guestClaims/claimRepository.js';
import {
  findOpenRevocationForClaim,
  findRevocationById,
  insertRevocationRequest,
  markRevocationExecuted,
  markRevocationWithdrawn,
  type GuestClaimRevocationRow,
} from '../../db/guestClaims/revocationRepository.js';
import {
  appendOrderStatusEvent,
  clearCheckoutGroupClaim,
  findOrdersInCheckoutGroup,
} from '../../db/orders/orderRepository.js';
import { log } from '../../lib/logger.js';

/**
 * The note a revocation writes onto every sibling order's lifecycle trail.
 *
 * Names no operator and no account, for `CLAIM_STATUS_NOTE`'s reason: the trail
 * is serialized to the seller too. The attributable record lives on the
 * revocation row, which no merchant reads.
 */
export const CLAIM_REVOCATION_STATUS_NOTE =
  'Order access returned to the guest checkout (audited claim revocation)';

/** Why a revocation request or approval was refused. Bounded, so a route can map it. */
export type GuestClaimRevocationRefusal =
  /** No claim with that id. */
  | 'claim_not_found'
  /** The claim is not `completed`, so there is nothing to detach. */
  | 'claim_not_active'
  /** A request is already standing for this claim — approve or withdraw that one. */
  | 'revocation_already_open'
  /** No revocation with that id. */
  | 'revocation_not_found'
  /** The revocation has already been executed or withdrawn. */
  | 'revocation_not_open'
  /** Four eyes: the approver is the operator who requested it. */
  | 'approver_is_requester';

/** How a revocation step ended. Discriminated on a STRING, so it narrows. */
export type GuestClaimRevocationOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'refused'; readonly refusal: GuestClaimRevocationRefusal };

/**
 * Open a revocation request against a completed claim.
 *
 * Writes NOTHING to the orders: a request is a proposal, and the whole point of
 * the two-step is that the proposal and the effect are separate acts by
 * separate people.
 */
export async function requestClaimRevocation(input: {
  claimId: string;
  reason: GuestClaimRevocationReason;
  evidenceRef: string;
  requestedByOxyUserId: string;
}): Promise<GuestClaimRevocationOutcome<GuestClaimRevocationRow>> {
  const db = getDb();
  const claim = await findClaimById(db, input.claimId);
  if (claim === null) return { status: 'refused', refusal: 'claim_not_found' };
  if (claim.state !== 'completed') {
    return { status: 'refused', refusal: 'claim_not_active' };
  }

  const created = await insertRevocationRequest(db, {
    claimId: input.claimId,
    reason: input.reason,
    evidenceRef: input.evidenceRef,
    requestedByOxyUserId: input.requestedByOxyUserId,
    // SNAPSHOTTED here and read nowhere else afterwards. See the module
    // docblock: the flag decides what THIS request needs, once.
    fourEyesRequired: config.guest.claim.fourEyesRequired,
  });
  if (created === null) {
    // Another operator already opened one. Refusing rather than returning
    // theirs, because the reason and the evidence on the standing request are
    // somebody else's account of the situation and this operator should read
    // it before approving it.
    return { status: 'refused', refusal: 'revocation_already_open' };
  }

  log.guest.warn(
    {
      revocationId: created.id,
      claimId: input.claimId,
      reason: input.reason,
      requestedBy: input.requestedByOxyUserId,
    },
    '[GuestClaim] revocation requested',
  );
  return { status: 'ok', value: created };
}

/**
 * Approve a standing request and EXECUTE the detach — one transaction.
 *
 * The four-eyes comparison is made here AND held by
 * `guest_order_claim_revocations_four_eyes_check`, which is not redundancy: the
 * service check produces a legible refusal an operator can act on, and the
 * CHECK is what holds when a future path forgets to make it.
 *
 * With `fourEyesRequired` false the requester may approve their own — that IS
 * what the flag means, and it exists so a deployment with one operator can
 * function. The row still records who approved, so the audit is complete either
 * way.
 */
export async function approveClaimRevocation(input: {
  revocationId: string;
  approvedByOxyUserId: string;
  now: Date;
}): Promise<
  GuestClaimRevocationOutcome<{
    revocation: GuestClaimRevocationRow;
    claim: GuestOrderClaimRow;
    detachedOrderIds: string[];
  }>
> {
  const db = getDb();
  const revocation = await findRevocationById(db, input.revocationId);
  if (revocation === null) return { status: 'refused', refusal: 'revocation_not_found' };
  if (revocation.state !== 'pending_approval') {
    return { status: 'refused', refusal: 'revocation_not_open' };
  }
  if (
    revocation.fourEyesRequired &&
    revocation.requestedByOxyUserId === input.approvedByOxyUserId
  ) {
    return { status: 'refused', refusal: 'approver_is_requester' };
  }

  return await db.transaction((tx) => execute(tx, revocation, input));
}

/** The execution transaction. Everything below commits together or not at all. */
async function execute(
  tx: DatabaseOrTransaction,
  revocation: GuestClaimRevocationRow,
  input: { approvedByOxyUserId: string; now: Date },
): Promise<
  GuestClaimRevocationOutcome<{
    revocation: GuestClaimRevocationRow;
    claim: GuestOrderClaimRow;
    detachedOrderIds: string[];
  }>
> {
  const claim = await findClaimById(tx, revocation.claimId);
  if (claim === null) return { status: 'refused', refusal: 'claim_not_found' };

  // Lock the LIVE claim on the group, so an approval cannot race a concurrent
  // claim of the same group — the claim transaction serializes on the contact
  // row before any claim row exists, and this one has one to lock.
  const active = await findActiveClaimForGroupForUpdate(tx, claim.checkoutGroupId);
  if (active === null || active.id !== claim.id) {
    // Either it was revoked already, or the group's live claim is a DIFFERENT
    // one — which can only mean this claim was revoked and the group re-claimed
    // in the meantime. Detaching the new owner on a stale approval is exactly
    // the silent transfer rule 1 forbids.
    return { status: 'refused', refusal: 'claim_not_active' };
  }

  const detachedOrderIds = await clearCheckoutGroupClaim(tx, {
    checkoutGroupId: claim.checkoutGroupId,
    claimedByOxyUserId: claim.claimedByOxyUserId,
    now: input.now,
  });

  // The trail, per order — the same shape the claim wrote, so a support
  // conversation reads one story rather than an event and a silence.
  const orders = await findOrdersInCheckoutGroup(claim.checkoutGroupId, tx);
  for (const order of orders) {
    await appendOrderStatusEvent(
      order.id,
      {
        status: order.status,
        at: input.now,
        actorKind: 'operator',
        byOxyUserId: input.approvedByOxyUserId,
        note: CLAIM_REVOCATION_STATUS_NOTE,
      },
      tx,
    );
  }

  const revoked = await markClaimRevoked(tx, {
    claimId: claim.id,
    revokedByOxyUserId: input.approvedByOxyUserId,
    reason: revocation.reason,
    now: input.now,
  });
  if (revoked === null) {
    // Unreachable while the lock above is held. Raising rather than converging:
    // the orders have already been detached in this transaction, so a claim row
    // that refused to move would leave the two disagreeing, and rolling back is
    // the only correct answer.
    throw new Error(
      `claim ${claim.id} could not be marked revoked after its orders were detached`,
    );
  }

  const executed = await markRevocationExecuted(tx, {
    revocationId: revocation.id,
    approvedByOxyUserId: input.approvedByOxyUserId,
    now: input.now,
  });
  if (executed === null) {
    throw new Error(`revocation ${revocation.id} was consumed by a concurrent approval`);
  }

  log.guest.warn(
    {
      revocationId: executed.id,
      claimId: claim.id,
      checkoutGroupId: claim.checkoutGroupId,
      approvedBy: input.approvedByOxyUserId,
      detachedOrderCount: detachedOrderIds.length,
    },
    '[GuestClaim] claim revoked; order access returned to the guest checkout',
  );

  return { status: 'ok', value: { revocation: executed, claim: revoked, detachedOrderIds } };
}

/** Withdraw a standing request. Attributable, and the record survives. */
export async function withdrawClaimRevocation(input: {
  revocationId: string;
  withdrawnByOxyUserId: string;
  now: Date;
}): Promise<GuestClaimRevocationOutcome<GuestClaimRevocationRow>> {
  const db = getDb();
  const withdrawn = await markRevocationWithdrawn(db, input);
  if (withdrawn === null) {
    const existing = await findRevocationById(db, input.revocationId);
    return {
      status: 'refused',
      refusal: existing === null ? 'revocation_not_found' : 'revocation_not_open',
    };
  }
  log.guest.info(
    { revocationId: withdrawn.id, withdrawnBy: input.withdrawnByOxyUserId },
    '[GuestClaim] revocation request withdrawn',
  );
  return { status: 'ok', value: withdrawn };
}

/** The standing request for a claim, if one is open — the operator's read. */
export async function readOpenRevocation(
  claimId: string,
): Promise<GuestClaimRevocationRow | null> {
  return await findOpenRevocationForClaim(getDb(), claimId);
}
