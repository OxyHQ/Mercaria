/**
 * Claiming a guest checkout group into an Oxy account (#109, ADR 0003 D14).
 *
 * ## The proof is a CONJUNCTION, and the SIGNATURE is what holds it
 *
 * {@link claimGuestCheckoutGroup} takes a resolved portal GRANT, an Oxy user
 * id, an optional presented guest CART session and a clock. That parameter list
 * is #109's reject rules, and it is worth reading as one:
 *
 *  - **A matching email cannot claim** (reject rule 1, invariant I6) because
 *    there is no email parameter. Not refused by a branch — unrepresentable.
 *  - **An order number cannot claim** (rule 2) for the same reason.
 *  - **The pre-purchase cart token cannot claim** (rule 3). It is accepted, but
 *    only as `presentedGuestSessionId`, and its ONLY use below is #104's cart
 *    merge. It is never compared, never sufficient and never consulted by any
 *    authorization decision.
 *  - **A card, wallet, Link identity or device cannot claim** (rule 4): none of
 *    them has a parameter, and the payment domain is not imported at all.
 *  - **A merchant's message cannot claim** (rule 5), and **being a seller on a
 *    sibling order cannot** (rule 6): the only order fact read is which
 *    contact record the group names.
 *  - **An operator typing an account id cannot claim** (rule 7). There is no
 *    operator entry point into this function — `GUEST_CLAIM_OPERATOR_ACTIONS`
 *    has three members and all three DETACH.
 *  - **A referral link, code, touch, partner or beneficiary cannot claim**
 *    (rules 8 and 9): this domain does not import the referral domain in any
 *    direction, which `guest-claim-isolation.test.ts` fails the build over.
 *
 * ## What is revalidated immediately before the commit, and what is not
 *
 * The GRANT is re-read inside the transaction (claim-transaction rule 1): a
 * buyer on another device can press "secure my access" between the request
 * arriving and the commit, and a claim authorized by a credential its owner had
 * just revoked is exactly the case that rule exists for.
 *
 * It is re-read AFTER the already-claimed check rather than before it, and that
 * ordering was measured rather than chosen: a winning claim revokes every
 * outstanding credential for its group INCLUDING the loser's, so revalidating
 * first answers a genuine contest with a credential error and loses the
 * `conflicted` row an operator needs to resolve a disputed purchase. See the
 * inline note at step (3).
 *
 * The same revocation has a consequence worth stating plainly rather than
 * hiding: a client retrying on the SAME credential is answered 401 by the
 * middleware, because the claim it is retrying revoked it. Claim-transaction
 * rule 12 is about what the SERVICE answers, and it converges for every request
 * that reaches it; the account's own order history is where a client that lost
 * the response looks. Sparing the presenting credential would fix the retry and
 * leave one emailed link live for thirty days after a claim, which is exactly
 * what D14 ends.
 *
 * The OXY SESSION is not re-verified, and that is a decision rather than an
 * omission. Verifying it again means an HTTP round trip to Oxy while a database
 * transaction holds a row lock — a lock whose duration would then be a function
 * of somebody else's availability. And the fact it would establish is not the
 * one that matters: `createOptionalOxyAuth` verified this request's bearer at
 * its start, and a token that expires four milliseconds later does not
 * retroactively unauthorize the request it authorized. Conflict case 5 ("Oxy
 * session expires during claim") is therefore answered by the request's own
 * verification, and a session that had ALREADY expired never reached here.
 *
 * ## Why the follow-up work is an outbox and not a call
 *
 * Conflict case 11 is "claim event emitted but downstream history projection
 * failed". Granting review eligibility inline would have precisely that failure
 * mode with no record of it: the transaction commits, the grant throws, the
 * buyer owns the orders and can never review them, and nothing anywhere says
 * so. The two `guest_order_claim_outbox` rows commit WITH the claim, so the
 * work is owed durably and a failure is a row an operator can see.
 *
 * The CART MERGE is the deliberate exception and runs inline AFTER the commit,
 * because it must not run inside: `mergeGuestCart` opens its own transaction
 * and takes its own locks, and calling it from inside this one is the deadlock
 * #59's merge runner already paid for. It is safe after the fact for the reason
 * it is safe at all — `UNIQUE(cart_merges.guest_session_id)` plus two row locks
 * make it exactly-once whoever calls it and however often.
 */

import type {
  GuestClaimCartMergeSummary,
  GuestClaimPreview,
  GuestClaimResult,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import type { GuestOrderAccessGrantRow } from '../../db/guestPortal/grantRepository.js';
import {
  grantIsStillLive,
  revokeGroupGrants,
} from '../../db/guestPortal/grantRepository.js';
import { findGuestCheckoutByGroupForUpdate } from '../../db/guests/guestCheckoutRepository.js';
import {
  findActiveClaimForGroup,
  insertCompletedClaim,
  insertConflictedClaim,
  type GuestOrderClaimRow,
} from '../../db/guestClaims/claimRepository.js';
import { enqueueGuestClaimJob } from '../../db/guestClaims/claimOutboxRepository.js';
import {
  appendOrderStatusEvent,
  findOrdersInCheckoutGroup,
  stampCheckoutGroupClaim,
} from '../../db/orders/orderRepository.js';
import { log } from '../../lib/logger.js';
import { mergeGuestCart } from '../cart-merge.service.js';
import { hydrateOrders } from '../order-hydration.service.js';
import { sellerLabel } from '../guest-portal/message.service.js';
import { grantHasScope } from '../guest-portal/scopes.js';
import { toClaimSummary } from './claim-projection.js';

/**
 * The note a claim writes onto every sibling order's lifecycle trail.
 *
 * A CONSTANT rather than a composed sentence, and it names no account: the
 * trail is serialized to the SELLER as well as the buyer, and "claimed by
 * <oxy user id>" would put a buyer identifier in a merchant response —
 * `MerchantOrder`'s whole reason for existing (#106 DTO rule 5).
 */
export const CLAIM_STATUS_NOTE = 'Order access moved to an Oxy account (guest claim)';

/** Why a claim was refused. Bounded, so a route can map it and a test can drive it. */
export type GuestClaimRefusal =
  /** `GUEST_CLAIM_ENABLED` is off on this deployment. */
  | 'claiming_unavailable'
  /** The presented credential does not carry `claim:write`. */
  | 'claim_scope_missing'
  /** The presented credential has no proven inbox behind it (ADR 0003 D17). */
  | 'inbox_not_verified'
  /** The credential was revoked or expired between the request and the commit. */
  | 'access_revoked'
  /** No contact record, no orders, or a group whose orders are not all its own. */
  | 'group_not_found'
  /** A DIFFERENT Oxy account already holds this group — 409, never an overwrite. */
  | 'claimed_by_another_account';

/** How a claim attempt ended. A discriminated union on a STRING, so it narrows. */
export type GuestClaimOutcome =
  | { readonly status: 'claimed'; readonly result: GuestClaimResult }
  | { readonly status: 'refused'; readonly refusal: GuestClaimRefusal };

/** What the caller must present. See the module docblock for what is absent. */
export interface GuestClaimInput {
  /** The resolved portal grant. Its `checkoutGroupId` IS the scope. */
  readonly grant: GuestOrderAccessGrantRow;
  /** The verified Oxy account the orders' ACCESS moves into. */
  readonly oxyUserId: string;
  /**
   * The guest CART credential this request also presented, if any.
   *
   * Surfaced by the resolver only for a credential that actually RESOLVED, so
   * this is never a session id a client merely named — the same guarantee
   * `mergeGuestCart` already relies on. Its only use is that merge.
   */
  readonly presentedGuestSessionId?: string;
  readonly now: Date;
}

/** The proofs that can be judged without touching the database. */
function refusalFromProofs(
  grant: GuestOrderAccessGrantRow,
): GuestClaimRefusal | null {
  if (!config.guest.claim.enabled) return 'claiming_unavailable';
  if (!grantHasScope(grant.scopes, 'claim:write')) return 'claim_scope_missing';
  // `email_verified_at` and not a derived boolean: D17 puts claiming firmly on
  // the proven-inbox side, and a `post_checkout` credential — proof of a DEVICE
  // — must never reach it. The database says the same thing
  // (`guest_order_access_grants_unverified_scope_check` holds an unverified
  // portal row to `tracking:read`), so this is the second of two walls.
  if (grant.emailVerifiedAt === null) return 'inbox_not_verified';
  return null;
}

/**
 * What the review screen shows before anybody confirms (#109 UX rules 5 and 6).
 *
 * A READ, and it changes nothing — which is why the claim endpoint is a
 * separate POST and why "never auto-submit the claim immediately after sign-in"
 * (UX rule 10) is a property of the API rather than a promise about the client:
 * there is no response from this function that could complete a claim.
 *
 * It carries the same bounded per-order facts `GuestOrderStatusView` does and
 * no more. A preview is rendered BEFORE a decision, so it must not disclose
 * anything a decline would have withheld.
 */
export async function previewGuestClaim(input: {
  readonly grant: GuestOrderAccessGrantRow;
  readonly oxyUserId: string;
}): Promise<GuestClaimPreview | null> {
  const db = getDb();
  const orders = await findOrdersInCheckoutGroup(input.grant.checkoutGroupId, db);
  if (orders.length === 0) return null;

  const existing = await findActiveClaimForGroup(db, input.grant.checkoutGroupId);
  const alreadyClaimedByYou =
    existing !== null && existing.claimedByOxyUserId === input.oxyUserId;
  const refusal = refusalFromProofs(input.grant);

  const blockReason =
    refusal === 'claiming_unavailable'
      ? ('claiming_unavailable' as const)
      : refusal === 'claim_scope_missing'
        ? ('claim_scope_missing' as const)
        : refusal === 'inbox_not_verified'
          ? ('inbox_not_verified' as const)
          : existing !== null && !alreadyClaimedByYou
            ? ('claimed_by_another_account' as const)
            : null;

  // Hydrated only for the seller's public display name, which is a live Oxy or
  // store read rather than an order column — the same one `GuestOrderStatusView`
  // renders, through the same function, so the review screen and the portal's
  // own list cannot disagree about who somebody bought from.
  const hydrated = await hydrateOrders([...orders]);

  return {
    checkoutGroupId: input.grant.checkoutGroupId,
    // Already-claimed-by-you is CLAIMABLE: a repeat converges on the same
    // result (claim-transaction rule 12), so offering it again is honest and a
    // client that retried after a lost response is not told "no".
    claimable: blockReason === null,
    alreadyClaimedByYou,
    ...(blockReason === null ? {} : { blockReason }),
    orders: hydrated.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      // The empty string rather than an invented placeholder when a profile
      // read failed — `toStatusEntry`'s decision, for its reason.
      sellerLabel: sellerLabel(order) ?? '',
      placedAt: order.createdAt,
    })),
  };
}

/**
 * Move one checkout group's orders into an Oxy account.
 *
 * ONE transaction for everything durable, and the ORDER of the statements
 * inside it is load-bearing — see the inline notes.
 */
export async function claimGuestCheckoutGroup(
  input: GuestClaimInput,
): Promise<GuestClaimOutcome> {
  const proofRefusal = refusalFromProofs(input.grant);
  if (proofRefusal !== null) return { status: 'refused', refusal: proofRefusal };

  const outcome = await getDb().transaction((tx) => runClaim(tx, input));
  if (outcome.status === 'refused') return outcome;

  // AFTER the commit, and never inside it: `mergeGuestCart` opens its own
  // transaction and takes its own locks. Best-effort, because the claim has
  // already happened and a cart is recoverable — the buyer's own
  // `POST /cart/merge` converges on the same result.
  const cartMerge = await mergePresentedCart(input);

  return {
    status: 'claimed',
    result: {
      ...outcome.result,
      ...(cartMerge === null ? {} : { cartMerge }),
    },
  };
}

/** The transaction body. Everything below commits together or not at all. */
async function runClaim(
  tx: DatabaseOrTransaction,
  input: GuestClaimInput,
): Promise<
  | { status: 'claimed'; result: GuestClaimResult }
  | { status: 'refused'; refusal: GuestClaimRefusal }
> {
  const checkoutGroupId = input.grant.checkoutGroupId;

  // (1) SERIALIZE on the group's contact row. Every concurrent claim of this
  // group queues here, which is what makes the "already claimed?" read below
  // authoritative rather than a guess a rival can walk past.
  const contact = await findGuestCheckoutByGroupForUpdate(tx, checkoutGroupId);
  if (contact === null) return { status: 'refused', refusal: 'group_not_found' };

  // (2) Every order of the group, and the check claim-transaction rule 3 asks
  // for: they must all still belong to THIS contact record. A group whose
  // siblings name two contacts is the `mixedOriginGroups` pathology, and
  // claiming half of it is worse than claiming none.
  const orders = await findOrdersInCheckoutGroup(checkoutGroupId, tx);
  if (orders.length === 0) return { status: 'refused', refusal: 'group_not_found' };
  if (orders.some((order) => order.buyerGuestCheckoutId !== contact.id)) {
    log.guest.error(
      { checkoutGroupId, contactId: contact.id },
      '[GuestClaim] refused: a sibling order names a different guest checkout',
    );
    return { status: 'refused', refusal: 'group_not_found' };
  }

  const insertInput = {
    checkoutGroupId,
    guestCheckoutId: contact.id,
    claimedByOxyUserId: input.oxyUserId,
    sourceGrantId: input.grant.id,
    orderCount: orders.length,
    now: input.now,
  };

  /**
   * (3) Already claimed? Two different answers, and neither is an overwrite.
   *
   * ## Why this runs BEFORE the credential is revalidated
   *
   * A winning claim revokes every outstanding credential for its group,
   * including the LOSER's — so in a genuine race the loser's grant is dead by
   * the time it acquires the lock. Revalidating first would answer a real
   * contest with a credential error: the rival would be told "your access is
   * not valid" instead of "somebody else holds this", and the `conflicted` row
   * an operator needs to resolve a disputed purchase would never be written.
   * Measured — the concurrent-claims case is what surfaced it.
   *
   * Reading the claim state first is safe because neither branch below is an
   * authorization: one CONVERGES on a claim the caller's own account already
   * holds, and the other RECORDS an attempt and refuses. Nothing is granted
   * before the revalidation at (4), which still gates every write that changes
   * who can reach an order.
   */
  const existing = await findActiveClaimForGroup(tx, checkoutGroupId);
  if (existing !== null) {
    if (existing.claimedByOxyUserId === input.oxyUserId) {
      // Conflict case 1, and claim-transaction rule 12: the SAME completed
      // result on retry. Nothing is written — not even a timestamp — so a
      // client that taps twice cannot move the record it is converging on.
      return { status: 'claimed', result: convergedResult(existing) };
    }
    // Conflict case 2 and 3. The contest is RECORDED and then refused: an
    // operator resolving a disputed purchase needs to see that a second account
    // presented valid proof, and a 409 that left no trace would make the only
    // observer of a contested group whoever happened to read the logs.
    const conflicted = await insertConflictedClaim(tx, {
      ...insertInput,
      conflictReason: 'already_claimed_by_another_account',
    });
    log.guest.warn(
      { checkoutGroupId, claimId: conflicted.id },
      '[GuestClaim] contested: the group is already claimed by another account',
    );
    return { status: 'refused', refusal: 'claimed_by_another_account' };
  }

  // (4) REVALIDATE the credential (claim-transaction rule 1), now that the
  // group is known to be unclaimed and everything below WRITES. Conflict case
  // 4: "guest access revoked during claim" — a second device pressed "secure my
  // access" while this request was in flight.
  if (!(await grantIsStillLive(tx, input.grant.id, input.now))) {
    return { status: 'refused', refusal: 'access_revoked' };
  }

  // (5) The claim row. `ON CONFLICT DO NOTHING` on the active-group partial
  // unique is the structural backstop behind the lock above: unreachable while
  // the lock is held, and still correct if a future refactor drops it.
  const claim = await insertCompletedClaim(tx, insertInput);
  if (claim === null) {
    const winner = await findActiveClaimForGroup(tx, checkoutGroupId);
    if (winner !== null && winner.claimedByOxyUserId === input.oxyUserId) {
      return { status: 'claimed', result: convergedResult(winner) };
    }
    return { status: 'refused', refusal: 'claimed_by_another_account' };
  }

  // (6) Stamp every sibling — a CAS on `claimed_by_oxy_user_id IS NULL`. The
  // count comparison is acceptance 4: a claim covers EVERY sibling order or it
  // covers none, and a partial stamp raises rather than committing half of one.
  const stamped = await stampCheckoutGroupClaim(tx, {
    checkoutGroupId,
    claimedByOxyUserId: input.oxyUserId,
    now: input.now,
  });
  if (stamped.length !== orders.length) {
    throw new Error(
      `guest claim would be partial: ${stamped.length} of ${orders.length} orders in ` +
        `checkout group ${checkoutGroupId} could be stamped. Refusing to split a group.`,
    );
  }

  // (7) The lifecycle trail, per order (ADR 0003 D14). `actorKind: 'oxy'` with
  // the claiming account, which `order_status_history_actor_check` requires the
  // pair for — and the status is the order's CURRENT one, because a claim moves
  // ownership and not fulfilment.
  for (const order of orders) {
    await appendOrderStatusEvent(
      order.id,
      {
        status: order.status,
        at: input.now,
        actorKind: 'oxy',
        byOxyUserId: input.oxyUserId,
        note: CLAIM_STATUS_NOTE,
      },
      tx,
    );
  }

  // (8) Revoke the group's outstanding portal credentials, INCLUDING the one
  // that authorized this claim (ADR 0003 D14: "after a claim, order access is
  // the Oxy account, not the emailed link"). No `exceptGrantId`: sparing the
  // presenting credential is right for "secure my access", where the point is
  // to keep the person who pressed it signed in, and wrong here, where the
  // point is that emailed access has been superseded.
  const revoked = await revokeGroupGrants(tx, checkoutGroupId, input.now);

  // (9) The durable follow-up work, committed WITH the claim. Deterministic
  // ids, so a retried transaction queues nothing twice.
  const expiresAt = new Date(
    input.now.getTime() + RETENTION_SECONDS.guestClaimOutbox * 1_000,
  );
  for (const type of ['review_eligibility', 'claim_notification'] as const) {
    await enqueueGuestClaimJob(tx, {
      claimId: claim.id,
      checkoutGroupId,
      type,
      availableAt: input.now,
      expiresAt,
    });
  }

  log.guest.info(
    {
      claimId: claim.id,
      checkoutGroupId,
      orderCount: orders.length,
      revokedGrantIds: revoked,
    },
    '[GuestClaim] checkout group claimed into an Oxy account',
  );

  return {
    status: 'claimed',
    result: {
      claim: toClaimSummary(claim),
      alreadyClaimed: false,
      portalAccessRevoked: true,
    },
  };
}

/** The answer a converging retry gets: the stored claim, flagged as pre-existing. */
function convergedResult(claim: GuestOrderClaimRow): GuestClaimResult {
  return {
    claim: toClaimSummary(claim),
    alreadyClaimed: true,
    // True on both paths, the `guestCredentialRevoked` reasoning from #104: the
    // grants were revoked by the claim that ran, and a retry's client must
    // still discard its credential — answering `false` here would be the one
    // case where the instruction is wrong.
    portalAccessRevoked: true,
  };
}

/**
 * Merge the guest cart this request presented, if it presented one.
 *
 * **Which cart, and why not the checkout's own session.** The merge moves
 * commerce state, and #104 requires possession of the cart credential to do it
 * — the resolver surfaces `presentedGuestSessionId` only for a credential that
 * actually resolved. A portal grant proves an INBOX, not a browser, so using it
 * to drain the cart of the session that placed the checkout would move a cart
 * this caller has not proved they hold: on a shared device, or after a claim
 * from a second machine, that cart may be somebody else's current basket. The
 * honest answer for a claim made from a device holding no cart credential is
 * that there is no cart here to merge, and the buyer's own `POST /cart/merge`
 * still works from the device that has one.
 *
 * Never throws: the claim has already committed, and a merge failure must not
 * turn a successful claim into an error the client reads as "it did not work".
 */
async function mergePresentedCart(
  input: GuestClaimInput,
): Promise<GuestClaimCartMergeSummary | null> {
  const guestSessionId = input.presentedGuestSessionId;
  if (guestSessionId === undefined) return null;
  try {
    const result = await mergeGuestCart({ guestSessionId, oxyUserId: input.oxyUserId });
    return {
      merged: result.merged,
      linesAdded: result.linesAdded,
      linesCombined: result.linesCombined,
      linesFlagged: result.linesFlagged,
    };
  } catch (err) {
    log.guest.error(
      { err, guestSessionId },
      '[GuestClaim] cart merge failed after the claim committed; the claim stands',
    );
    return null;
  }
}
