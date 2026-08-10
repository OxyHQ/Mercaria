/**
 * The guest-P2P policy surface for an operator (#112).
 *
 * TWO reads and no writes, behind the SAME `GUEST_OPERATOR_OXY_USER_IDS`
 * allow-list #104, #108, #109 and #110 use — not a seventh list, because this
 * is the same power class: a guest-commerce question answered without learning
 * what anybody bought or who they are.
 *
 * ## The omissions are the design
 *
 * There is no "authorize this seller", no "waive this criterion", no "set this
 * verdict" and no "enable the pilot". Every one of those would be a way to
 * approve a bounded scope without a dated decision, which is precisely what
 * #112 acceptance 1 forbids — approval is a commit to
 * `services/guest-p2p/authorization.ts` with an author and a date, reviewable
 * against the document it cites.
 *
 * ## The trace opens from a LISTING, and answers about a listing
 *
 * Not from a buyer, not from a session, not from a checkout group: the subject
 * of this policy is a seller's item, and "what did this guest try to buy" is
 * not a question the surface can be asked. The response carries no buyer field
 * of any kind, and `readGuestP2PFacts` has no parameter that could accept one.
 */

import type { Request, Response } from 'express';
import type { GuestP2PPolicyPublication } from '@mercaria/shared-types';
import { GUEST_P2P_FORBIDDEN_CRITERIA } from '@mercaria/shared-types';
import { GUEST_P2P_DECISION } from '../services/guest-p2p/authorization.js';
import { deriveGuestP2PEligibility } from '../services/guest-p2p/eligibility.js';
import {
  GUEST_P2P_BEST_CASE_CONTEXT,
  readGuestP2PFacts,
} from '../services/guest-p2p/facts.js';
import {
  GUEST_P2P_BOUNDED_SCOPE,
  GUEST_P2P_POLICY_VERSION,
  publishedGuestP2PCriteria,
} from '../services/guest-p2p/policy.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * GET /internal/guest-commerce/p2p/policy — the published policy.
 *
 * Static: the criteria, where each one's answer comes from, the bounded scope a
 * pilot would run inside, the prohibited inputs, and the decision this is all
 * published under. Nothing here is per-seller or per-listing, so it is the
 * document an operator reads BEFORE tracing anything.
 */
export function guestP2PPolicyHandler(_req: Request, res: Response): void {
  const publication: GuestP2PPolicyPublication = {
    policyVersion: GUEST_P2P_POLICY_VERSION,
    decision: {
      documentPath: GUEST_P2P_DECISION.documentPath,
      date: GUEST_P2P_DECISION.date,
      outcome: GUEST_P2P_DECISION.outcome,
    },
    scope: GUEST_P2P_BOUNDED_SCOPE,
    criteria: publishedGuestP2PCriteria(),
    forbiddenCriteria: [...GUEST_P2P_FORBIDDEN_CRITERIA],
  };
  sendSuccess(res, publication);
}

/**
 * GET /internal/guest-commerce/p2p/listings/:listingId — what it would take.
 *
 * Answers every criterion for one P2P listing under
 * {@link GUEST_P2P_BEST_CASE_CONTEXT}, which the response ECHOES: the four
 * checkout dimensions a listing does not carry are an assumption here, and an
 * assumption that is not printed reads as a fact about a purchase.
 *
 * A store listing 404s. It has no guest-P2P eligibility to derive, and
 * answering one would invent a subject — the same reason `readGuestP2PFacts`
 * returns `null` rather than a verdict.
 */
export async function traceGuestP2PListingHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params.listingId;
  if (typeof listingId !== 'string' || listingId.length === 0) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A listing id is required', 400);
    return;
  }

  try {
    const facts = await readGuestP2PFacts({
      listingId,
      context: GUEST_P2P_BEST_CASE_CONTEXT,
    });
    if (!facts) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No P2P listing with that id', 404);
      return;
    }
    sendSuccess(res, {
      context: GUEST_P2P_BEST_CASE_CONTEXT,
      eligibility: deriveGuestP2PEligibility(facts),
    });
  } catch (err) {
    log.guest.error({ err, listingId }, '[Guest] guest-P2P listing trace failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not trace guest-P2P eligibility', 500);
  }
}
