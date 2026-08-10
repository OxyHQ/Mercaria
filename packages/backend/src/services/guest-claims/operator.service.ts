/**
 * What an operator may LEARN about claiming (#109 revocation rule 8).
 *
 * Two reads and no third. The trace opens from a CHECKOUT GROUP and nothing
 * else — no email, no hash, no order number, no session id, no Oxy account — so
 * "show me every purchase this person has claimed" is not a question this
 * surface can be asked. That is the `GuestPortalTrace` rule and the payment
 * trace's five handles, applied to a domain whose whole subject matter is which
 * named person owns which purchase.
 *
 * The consistency read takes no parameter at all and returns counts.
 */

import type { GuestClaimConsistency, GuestClaimTrace } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  listClaimsForGroup,
  readClaimConsistency,
} from '../../db/guestClaims/claimRepository.js';
import { listRevocationsForClaims } from '../../db/guestClaims/revocationRepository.js';
import { listGuestClaimJobsForGroup } from '../../db/guestClaims/claimOutboxRepository.js';
import {
  toClaimSummary,
  toOutboxEntry,
  toRevocationSummary,
} from './claim-projection.js';

/** How much of each list a trace returns. Bounded, so one group cannot be a dump. */
const TRACE_LIMIT = 50;

/**
 * Everything recorded about one checkout group's claims.
 *
 * Returns a trace even when nothing was ever claimed — an empty one — rather
 * than 404ing. A distinguishable answer would make this surface a
 * group-existence oracle for an operator who typed an id wrong, and the empty
 * shape is the honest answer to "what has happened to this group": nothing.
 */
export async function traceGuestClaims(checkoutGroupId: string): Promise<GuestClaimTrace> {
  const db = getDb();
  const claims = await listClaimsForGroup(db, checkoutGroupId, TRACE_LIMIT);
  const [revocations, outbox] = await Promise.all([
    listRevocationsForClaims(
      db,
      claims.map((claim) => claim.id),
      TRACE_LIMIT,
    ),
    listGuestClaimJobsForGroup(db, checkoutGroupId, TRACE_LIMIT),
  ]);

  return {
    checkoutGroupId,
    claims: claims.map(toClaimSummary),
    revocations: revocations.map(toRevocationSummary),
    outbox: outbox.map(toOutboxEntry),
  };
}

/**
 * The two cross-table claim invariants, counted (#109 revocation rule 8).
 *
 * READ-ONLY, the `readBuyerIdentityConsistency` posture: a drifting claim is a
 * decision about who owns a purchase, and #50's "nothing auto-rewrites
 * financial history to hide a mismatch" applies to an ownership record for the
 * same reason it applies to a ledger entry. The repair for both findings is the
 * audited revocation path, driven by a person who has looked.
 */
export async function readGuestClaimConsistency(): Promise<GuestClaimConsistency> {
  return await readClaimConsistency(getDb());
}
