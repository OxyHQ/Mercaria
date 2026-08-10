/**
 * The safe projections of the claim domain's three tables (#109).
 *
 * Every function here NAMES each field it emits — the `provider_accounts`
 * status-projection rule (#46). A `{...row}` spread would ship whatever column
 * somebody adds next, and this is a domain where the next column somebody
 * reaches for is a contact.
 *
 * What no projection below can carry, because no field exists for it: an email
 * in any form, a phone, a hash, an address, a payment identifier, a portal
 * token, or the identity of a RIVAL claimant. That last one is the subtle one
 * and it is deliberate: a contested group tells the loser that somebody else
 * holds it and never who, because "which Oxy account owns this purchase" is a
 * fact about a stranger.
 */

import type {
  GuestClaimOutboxEntry,
  GuestClaimRevocationSummary,
  GuestOrderClaimSummary,
} from '@mercaria/shared-types';
import type { GuestOrderClaimRow } from '../../db/guestClaims/claimRepository.js';
import type { GuestClaimRevocationRow } from '../../db/guestClaims/revocationRepository.js';
import type { GuestClaimOutboxRow } from '../../db/guestClaims/claimOutboxRepository.js';

/**
 * One claim, as its own claimant and an operator both see it.
 *
 * ONE projection for both audiences rather than two, and that is safe precisely
 * because of what it omits: there is nothing here an operator may see and a
 * buyer may not. `source_grant_id` is deliberately absent from the DTO even
 * though the row carries it — it authorizes nothing, but it is a correlation
 * handle between a claim and a credential, and neither audience needs one.
 */
export function toClaimSummary(row: GuestOrderClaimRow): GuestOrderClaimSummary {
  return {
    id: row.id,
    checkoutGroupId: row.checkoutGroupId,
    claimedByOxyUserId: row.claimedByOxyUserId,
    state: row.state,
    orderCount: row.orderCount,
    policyVersion: row.policyVersion,
    ...(row.conflictReason === null ? {} : { conflictReason: row.conflictReason }),
    createdAt: row.createdAt.toISOString(),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt.toISOString() }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.toISOString() }),
    ...(row.revokedByOxyUserId === null
      ? {}
      : { revokedByOxyUserId: row.revokedByOxyUserId }),
    ...(row.revocationReason === null ? {} : { revocationReason: row.revocationReason }),
  };
}

/** One revocation request, for the operator surface. */
export function toRevocationSummary(
  row: GuestClaimRevocationRow,
): GuestClaimRevocationSummary {
  return {
    id: row.id,
    claimId: row.claimId,
    state: row.state,
    reason: row.reason,
    evidenceRef: row.evidenceRef,
    requestedByOxyUserId: row.requestedByOxyUserId,
    fourEyesRequired: row.fourEyesRequired,
    ...(row.approvedByOxyUserId === null
      ? {}
      : { approvedByOxyUserId: row.approvedByOxyUserId }),
    createdAt: row.createdAt.toISOString(),
    ...(row.executedAt === null ? {} : { executedAt: row.executedAt.toISOString() }),
    ...(row.withdrawnAt === null ? {} : { withdrawnAt: row.withdrawnAt.toISOString() }),
    ...(row.withdrawnByOxyUserId === null
      ? {}
      : { withdrawnByOxyUserId: row.withdrawnByOxyUserId }),
  };
}

/** One durable follow-up job, for the operator trace. */
export function toOutboxEntry(row: GuestClaimOutboxRow): GuestClaimOutboxEntry {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}
