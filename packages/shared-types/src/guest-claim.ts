/**
 * Claiming a guest checkout group into an Oxy account (#109, ADR 0003 D14).
 *
 * A claim gives an Oxy account ACCESS to orders somebody placed as a guest. It
 * is the one operation in guest commerce that connects a purchase to a named
 * person, so every type below is shaped by what must NOT be able to cause one.
 *
 * ## The proof is a CONJUNCTION and it is held by the service SIGNATURE
 *
 * ADR 0003 D14 requires both halves in one request: a verified Oxy session, and
 * a live `email_verified` portal grant carrying `claim:write` for the exact
 * checkout group. Every other candidate proof — a matching email, an order
 * number, the pre-purchase cart token, the same card or wallet, a merchant's
 * message, being a seller on a sibling order, an operator typing an account id,
 * a referral link or a partner's identity — is not refused by a branch
 * somewhere. None of them has a parameter to arrive in: `claimGuestCheckoutGroup`
 * takes a grant row, an Oxy user id and a clock, and there is no operator action
 * that claims anything (see {@link GUEST_CLAIM_OPERATOR_ACTIONS}).
 *
 * ## Nothing here can hold a contact
 *
 * No type below has an email, a phone, a hash, an address or a payment
 * identifier, in any form. A claim's audit is a group id, an account id, a grant
 * row id and a timestamp — the `GuestPortalTrace` discipline, one domain over.
 */

/**
 * Where a claim stands.
 *
 * THREE states, and the two the issue lists that are absent are absent for
 * different reasons — which is worth stating, because a missing lifecycle value
 * usually means somebody forgot one.
 *
 *  - **`pending` is unrepresentable.** The claim is ONE transaction (D14): the
 *    orders are stamped, the grants revoked and the row written together or not
 *    at all. There is no instant at which a claim exists and is not complete, so
 *    a `pending` row would be a state nothing could ever advance and every
 *    consistency check would have to special-case.
 *  - **`rejected` names a refusal this table never sees.** Every refusal the
 *    domain can produce happens BEFORE both proofs are in hand — a missing
 *    scope, an unverified inbox, a group that is not the grant's — and a
 *    refusal recorded before the proofs would be a row an anonymous caller could
 *    create. The one refusal that arrives WITH both proofs is a contest, and
 *    that is `conflicted`.
 */
export const GUEST_ORDER_CLAIM_STATES = [
  /** The orders carry this account and the group is claimed. */
  'completed',
  /** A second account presented valid proof for a group somebody else holds. */
  'conflicted',
  /** An audited operator correction detached the orders again. */
  'revoked',
] as const;

/** One of {@link GUEST_ORDER_CLAIM_STATES}. */
export type GuestOrderClaimState = (typeof GUEST_ORDER_CLAIM_STATES)[number];

/**
 * Why a claim attempt was recorded as a contest.
 *
 * ONE member today, and the tuple exists rather than a boolean because the
 * question an operator asks is "why did this not go through", and a column that
 * can only say "yes" answers it with the row's own existence. A second member
 * would be a second way for a fully-proven attempt to fail, and there is none.
 */
export const GUEST_CLAIM_CONFLICT_REASONS = [
  /**
   * The group is already claimed by a DIFFERENT Oxy account.
   *
   * Answered 409 and never an overwrite: `orders`' origin trigger refuses a
   * value → value move on `claimed_by_oxy_user_id`, so a service bug cannot
   * resolve a contest by winning it. The remedy is an audited operator unclaim.
   */
  'already_claimed_by_another_account',
] as const;

/** One of {@link GUEST_CLAIM_CONFLICT_REASONS}. */
export type GuestClaimConflictReason = (typeof GUEST_CLAIM_CONFLICT_REASONS)[number];

/**
 * Why an operator detached a claim.
 *
 * BOUNDED, never free text, for the `payment_repairs` reason: a reason column
 * an operator can type a sentence into is one that eventually contains a
 * buyer's email address, and this domain spends its whole design keeping one out
 * of reach. The evidence REFERENCE beside it is where a case number goes.
 */
export const GUEST_CLAIM_REVOCATION_REASONS = [
  /** The claim landed on an account that is not the buyer's. */
  'wrong_account',
  /** The claiming account or the contact inbox behind it was compromised. */
  'account_compromise',
  /** Two accounts contested the group and an operator resolved it. */
  'contested_ownership',
  /** The buyer asked for their purchase to be detached from the account. */
  'buyer_request',
  /** A legal, regulatory or compliance instruction. */
  'legal_or_compliance',
] as const;

/** One of {@link GUEST_CLAIM_REVOCATION_REASONS}. */
export type GuestClaimRevocationReason = (typeof GUEST_CLAIM_REVOCATION_REASONS)[number];

/**
 * Where a revocation REQUEST stands.
 *
 * A revocation is a two-step act, not a parameter on a delete: one operator
 * requests it with a reason and an evidence reference, a DIFFERENT one approves
 * and it executes. That is #109's "high-risk correction requires operator
 * authorization, reason, evidence and second approval where appropriate", and
 * the second approval is a separate REQUEST rather than a second id typed into
 * the first — one person can type two ids.
 */
export const GUEST_CLAIM_REVOCATION_STATES = [
  'pending_approval',
  'executed',
  'withdrawn',
] as const;

/** One of {@link GUEST_CLAIM_REVOCATION_STATES}. */
export type GuestClaimRevocationState = (typeof GUEST_CLAIM_REVOCATION_STATES)[number];

/**
 * What an operator may do to a claim, and NOTHING else.
 *
 * Three steps of ONE capability — detaching a claim somebody made — and
 * deliberately no fourth. There is no `claim_for_account`: #109 reject rule 7
 * says an operator typing an Oxy user id is not a proof, and the strongest form
 * of that is having no action that takes one. There is likewise no
 * "move to another account": a correction is a detach, after which the rightful
 * buyer claims it themselves through the ordinary two-sided proof.
 */
export const GUEST_CLAIM_OPERATOR_ACTIONS = [
  'request_revocation',
  'approve_revocation',
  'withdraw_revocation',
] as const;

/** One of {@link GUEST_CLAIM_OPERATOR_ACTIONS}. */
export type GuestClaimOperatorAction = (typeof GUEST_CLAIM_OPERATOR_ACTIONS)[number];

/**
 * The durable follow-up work a completed claim owes.
 *
 * #109 claim-transaction rule 10 asks for "durable claim-completed events for
 * order history, notifications and review eligibility", and conflict case 11
 * names the failure they exist to survive: the claim committed and a downstream
 * projection did not. So they are OUTBOX ROWS committed in the claim's own
 * transaction, drained by a leased worker, each idempotent — never a best-effort
 * call after the response.
 *
 * TWO types rather than one row doing both, because they fail independently: a
 * message transport that is unconfigured (#108 leaves it a named seam) must not
 * stop a buyer's verified-purchase eligibility from being granted.
 */
export const GUEST_CLAIM_OUTBOX_TYPES = [
  /** Grant the #76 verified-purchase eligibility for every claimed order line. */
  'review_eligibility',
  /** Tell the checkout's contact inbox that emailed access has moved (D14). */
  'claim_notification',
] as const;

/** One of {@link GUEST_CLAIM_OUTBOX_TYPES}. */
export type GuestClaimOutboxType = (typeof GUEST_CLAIM_OUTBOX_TYPES)[number];

/** Where one durable follow-up job stands. The moderation outbox's vocabulary. */
export const GUEST_CLAIM_OUTBOX_STATES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'dead_letter',
] as const;

/** One of {@link GUEST_CLAIM_OUTBOX_STATES}. */
export type GuestClaimOutboxState = (typeof GUEST_CLAIM_OUTBOX_STATES)[number];

/**
 * The version of the claim POLICY a stored claim was made under.
 *
 * The `guest_checkouts.contact_policy_version` device: which proofs were
 * required, what a claim revoked and what it left alone are policy, and a
 * stored claim must say which version of it produced the row rather than being
 * silently reinterpreted when the policy moves.
 */
export const GUEST_CLAIM_POLICY_VERSION = '2026-08-10.1';

/**
 * Why a checkout group cannot be claimed right now.
 *
 * BOUNDED, and every member is a fact the caller already knows or can act on —
 * there is no member that discloses anything about the account holding a
 * contested group, because "somebody else has this" is the whole of what a
 * rival claimant may learn.
 */
export const GUEST_CLAIM_BLOCK_REASONS = [
  /** Claiming is switched off on this deployment. */
  'claiming_unavailable',
  /** The presented credential does not carry `claim:write`. */
  'claim_scope_missing',
  /** The presented credential has no proven inbox behind it (ADR 0003 D17). */
  'inbox_not_verified',
  /** A different Oxy account already holds this group. */
  'claimed_by_another_account',
] as const;

/** One of {@link GUEST_CLAIM_BLOCK_REASONS}. */
export type GuestClaimBlockReason = (typeof GUEST_CLAIM_BLOCK_REASONS)[number];

/**
 * One sibling order as the claim REVIEW screen shows it.
 *
 * Deliberately the `GuestOrderStatusEntry` field set and not the full order: the
 * review screen answers "which purchase am I attaching", and it is rendered
 * before the person has decided, so it must not be a way to read detail a
 * decline would have withheld. No money, no address, no item titles, no contact.
 */
export interface GuestClaimOrderRef {
  /** The order row id. */
  id: string;
  /** The printed, sequential, PUBLIC order number (ADR 0003 T6). */
  orderNumber: string;
  /** The order's coarse lifecycle status. */
  status: string;
  /** The seller's public display name. Never a payout account or a contact. */
  sellerLabel: string;
  /** ISO instant the order was placed. */
  placedAt: string;
}

/**
 * What the claim review screen reads before anybody confirms.
 *
 * #109 UX rules 5 and 6: show which checkout and which sibling orders will be
 * attached, and require an explicit confirmation. This is the SHOWING; the POST
 * is the confirmation, and there is no auto-submit path between them.
 */
export interface GuestClaimPreview {
  /** The ONE checkout group in question. Every order below belongs to it. */
  checkoutGroupId: string;
  /** Whether a claim would be accepted right now. */
  claimable: boolean;
  /**
   * Whether THIS account already holds the group.
   *
   * True means a claim would converge on the existing one and change nothing —
   * so the screen says "already saved" instead of offering the action again.
   */
  alreadyClaimedByYou: boolean;
  /** Why not, when `claimable` is false. Absent otherwise. */
  blockReason?: GuestClaimBlockReason;
  /** Every sibling order the claim would attach, oldest first. */
  orders: GuestClaimOrderRef[];
}

/** The safe projection of one stored claim. Carries no credential and no contact. */
export interface GuestOrderClaimSummary {
  /** The stable claim id (#109 claim-model rule 1). */
  id: string;
  checkoutGroupId: string;
  /** The Oxy account the claim moved order ACCESS into. */
  claimedByOxyUserId: string;
  state: GuestOrderClaimState;
  /** How many sibling orders it covered — a claim is group-atomic. */
  orderCount: number;
  /** Which policy version required which proofs. */
  policyVersion: string;
  /** Present exactly on a `conflicted` row. */
  conflictReason?: GuestClaimConflictReason;
  createdAt: string;
  /** Present on `completed` and `revoked`. */
  completedAt?: string;
  /** Present on `revoked`. */
  revokedAt?: string;
  /** Present on `revoked` — the operator who executed the detach. */
  revokedByOxyUserId?: string;
  /** Present on `revoked`. */
  revocationReason?: GuestClaimRevocationReason;
}

/**
 * What a completed claim answers with.
 *
 * `alreadyClaimed` is what makes a retry honest rather than merely silent
 * (#109 claim-transaction rule 12): the SAME completed result comes back, and
 * the flag says the work happened earlier rather than now.
 */
export interface GuestClaimResult {
  /** The claim, whether this request made it or converged on it. */
  claim: GuestOrderClaimSummary;
  /** True when this request found the claim already made by the same account. */
  alreadyClaimed: boolean;
  /**
   * Always true: a claim revokes the group's outstanding portal credentials,
   * including the one that authorized it (ADR 0003 D14). The client must
   * discard its portal credential — order access is the Oxy account now.
   */
  portalAccessRevoked: true;
  /**
   * Whether a guest CART was merged as part of this claim, and how it went.
   *
   * Absent when the request presented no live guest cart credential, which is
   * the ordinary case for a claim made from a second device. It is deliberately
   * not an error: #104's merge is the only thing that may move a cart, and it
   * requires possession of the cart credential — a portal link proves an inbox,
   * not a browser.
   */
  cartMerge?: GuestClaimCartMergeSummary;
}

/** The counts a claim's cart merge produced. The `CartMergeResult` figures, without the cart. */
export interface GuestClaimCartMergeSummary {
  /** False when the merge had already run for that session, or there was nothing to move. */
  merged: boolean;
  linesAdded: number;
  linesCombined: number;
  linesFlagged: number;
}

/** One recorded revocation request, as the operator surface shows it. */
export interface GuestClaimRevocationSummary {
  id: string;
  claimId: string;
  state: GuestClaimRevocationState;
  reason: GuestClaimRevocationReason;
  /** A case or ticket reference. Never a description of a person. */
  evidenceRef: string;
  requestedByOxyUserId: string;
  /** Whether a second operator's approval was required when this was requested. */
  fourEyesRequired: boolean;
  approvedByOxyUserId?: string;
  createdAt: string;
  executedAt?: string;
  withdrawnAt?: string;
  withdrawnByOxyUserId?: string;
}

/** One durable follow-up job, as the operator trace shows it. */
export interface GuestClaimOutboxEntry {
  id: string;
  type: GuestClaimOutboxType;
  state: GuestClaimOutboxState;
  attempts: number;
  /** A bounded description of the last failure. Never a stack trace. */
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Everything an operator may learn about one checkout group's claims.
 *
 * Opens from a CHECKOUT GROUP and nothing else — the `GuestPortalTrace` rule.
 * There is no email, no hash, no order number, no session id and no account
 * lookup, so "show me every purchase this person has claimed" is not a question
 * this surface can be asked.
 */
export interface GuestClaimTrace {
  checkoutGroupId: string;
  claims: GuestOrderClaimSummary[];
  revocations: GuestClaimRevocationSummary[];
  outbox: GuestClaimOutboxEntry[];
}

/**
 * The two cross-row claim invariants no CHECK can express.
 *
 * The partial unique index makes two live claims on one group impossible; these
 * count the DRIFT between the claim record and the orders it is about, which
 * lives in two tables and therefore in no single constraint. Both should always
 * be zero. Read-only, the `readBuyerIdentityConsistency` posture: each is a
 * decision about a commercial record.
 */
export interface GuestClaimConsistency {
  /**
   * Completed claims whose group's orders do not all carry that claimant.
   *
   * The claim transaction stamps every sibling under one lock, so a nonzero
   * count means an order was inserted into an already-claimed group — which is
   * the only way the two can drift, and is worth seeing.
   */
  claimOrderDrift: { count: number; sample: string[] };
  /**
   * Orders carrying a claimant with no completed claim row naming their group.
   *
   * `orders.claimed_by_oxy_user_id` has exactly one writer; a row here means
   * something else wrote it, which is the fact ADR 0003 I6 rests on.
   */
  unrecordedClaims: { count: number; sample: string[] };
}
