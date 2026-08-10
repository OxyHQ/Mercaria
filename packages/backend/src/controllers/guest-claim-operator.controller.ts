/**
 * The claim domain's operator handlers (#109 revocation rules 3, 4 and 8).
 *
 * Behind `requireGuestOperator` — the SAME `GUEST_OPERATOR_OXY_USER_IDS`
 * allow-list #104's diagnostic and #108's portal surface use, and deliberately
 * not a seventh list. Detaching a claim is the same power class as revoking a
 * group's portal access: a guest-commerce support decision about who may reach
 * a placed order, made without learning what anyone bought.
 *
 * ## What these handlers cannot be asked
 *
 * There is no "claim this group for account X". #109 reject rule 7 says an
 * operator typing an Oxy user id is not a proof, and the strongest form of that
 * is having no action that takes one — so the write surface is three steps of
 * ONE capability, all of which DETACH. After a correction the rightful buyer
 * claims through the ordinary two-sided proof, from their own inbox.
 *
 * The trace opens from a CHECKOUT GROUP and nothing else: no email, no hash, no
 * order number, no Oxy account. "Show me every purchase this person has
 * claimed" has no request shape.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { GUEST_CLAIM_REVOCATION_REASONS } from '@mercaria/shared-types';
import { log } from '../lib/logger.js';
import { routeParam } from '../utils/request.js';
import {
  readGuestClaimConsistency,
  traceGuestClaims,
} from '../services/guest-claims/operator.service.js';
import {
  approveClaimRevocation,
  requestClaimRevocation,
  withdrawClaimRevocation,
  type GuestClaimRevocationRefusal,
} from '../services/guest-claims/revocation.service.js';
import { toRevocationSummary } from '../services/guest-claims/claim-projection.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';

/**
 * `.strict()`, and note what it does NOT admit: an Oxy user id, a checkout
 * group, an order id or a free-text reason.
 *
 * The reason is a member of a CLOSED tuple, unlike #108's operator schema where
 * it is a sentence — and the difference is what the two record. A re-send's
 * reason explains a support interaction; a revocation's reason is a
 * CLASSIFICATION that will be counted and audited, and a free-text field on a
 * form an operator fills in about a buyer is where an email address eventually
 * lands. The evidence REFERENCE is where a case number goes.
 */
const revocationRequestSchema = z
  .object({
    reason: z.enum(GUEST_CLAIM_REVOCATION_REASONS),
    evidenceRef: z.string().trim().min(1).max(200),
  })
  .strict();

/** The approve and withdraw steps take no body at all — the actor is the credential. */
const emptySchema = z.object({}).strict();

/** Map a bounded refusal onto a status and a sentence. Exhaustive, so a new one fails `tsc`. */
function refusalStatus(refusal: GuestClaimRevocationRefusal): { code: string; status: number } {
  switch (refusal) {
    case 'claim_not_found':
      return { code: ErrorCodes.NOT_FOUND, status: 404 };
    case 'revocation_not_found':
      return { code: ErrorCodes.NOT_FOUND, status: 404 };
    case 'claim_not_active':
    case 'revocation_already_open':
    case 'revocation_not_open':
      return { code: ErrorCodes.CONFLICT, status: 409 };
    case 'approver_is_requester':
      return { code: ErrorCodes.FORBIDDEN, status: 403 };
  }
}

/** GET /internal/guest-commerce/claims/consistency — the two drift probes. */
export async function guestClaimConsistencyHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await readGuestClaimConsistency());
  } catch (err) {
    log.guest.error({ err }, '[GuestClaim] consistency read failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to read claim consistency', 500);
  }
}

/** GET /internal/guest-commerce/claims/checkouts/:checkoutGroupId — the trace. */
export async function traceGuestClaimsHandler(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.…`: Express types a param as
  // `string | string[]`, and a checkout group is a single value.
  const checkoutGroupId = routeParam(req, 'checkoutGroupId');
  try {
    sendSuccess(res, await traceGuestClaims(checkoutGroupId));
  } catch (err) {
    log.guest.error({ err, checkoutGroupId }, '[GuestClaim] operator trace failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to trace claims', 500);
  }
}

/**
 * POST /internal/guest-commerce/claims/:claimId/revocations — open a request.
 *
 * Writes nothing to the orders. A request is a proposal, and the whole point of
 * the two-step is that the proposal and the effect are separate acts by
 * separate people.
 */
export async function requestClaimRevocationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const claimId = routeParam(req, 'claimId');
  const parsed = revocationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'A recognised reason and an evidence reference are required',
      400,
    );
    return;
  }

  try {
    const outcome = await requestClaimRevocation({
      claimId,
      reason: parsed.data.reason,
      evidenceRef: parsed.data.evidenceRef,
      requestedByOxyUserId: getRequiredOxyUserId(req),
    });
    if (outcome.status === 'refused') {
      const mapped = refusalStatus(outcome.refusal);
      // The refusal CODE is returned verbatim: the caller is an identified,
      // allow-listed person acting on a claim they already named, so there is
      // no enumeration to protect against — and "it did not work" with no
      // reason is the answer that generates a second support ticket (#108's
      // operator surface makes the same call).
      sendError(res, mapped.code, `Cannot open a revocation: ${outcome.refusal}`, mapped.status);
      return;
    }
    sendSuccess(res, toRevocationSummary(outcome.value), 201);
  } catch (err) {
    log.guest.error({ err, claimId }, '[GuestClaim] revocation request failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to open a revocation', 500);
  }
}

/**
 * POST /internal/guest-commerce/claim-revocations/:revocationId/approve
 *
 * Approves AND executes, in one transaction. The approver comes from the
 * credential and never from the body: an approval a caller could attribute to
 * somebody else is not an approval.
 */
export async function approveClaimRevocationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const revocationId = routeParam(req, 'revocationId');
  if (!emptySchema.safeParse(req.body ?? {}).success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'This action takes no body', 400);
    return;
  }

  try {
    const outcome = await approveClaimRevocation({
      revocationId,
      approvedByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });
    if (outcome.status === 'refused') {
      const mapped = refusalStatus(outcome.refusal);
      sendError(res, mapped.code, `Cannot approve: ${outcome.refusal}`, mapped.status);
      return;
    }
    sendSuccess(res, {
      revocation: toRevocationSummary(outcome.value.revocation),
      detachedOrderCount: outcome.value.detachedOrderIds.length,
    });
  } catch (err) {
    log.guest.error({ err, revocationId }, '[GuestClaim] revocation approval failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to approve the revocation', 500);
  }
}

/** POST /internal/guest-commerce/claim-revocations/:revocationId/withdraw */
export async function withdrawClaimRevocationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const revocationId = routeParam(req, 'revocationId');
  if (!emptySchema.safeParse(req.body ?? {}).success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'This action takes no body', 400);
    return;
  }

  try {
    const outcome = await withdrawClaimRevocation({
      revocationId,
      withdrawnByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });
    if (outcome.status === 'refused') {
      const mapped = refusalStatus(outcome.refusal);
      sendError(res, mapped.code, `Cannot withdraw: ${outcome.refusal}`, mapped.status);
      return;
    }
    sendSuccess(res, toRevocationSummary(outcome.value));
  } catch (err) {
    log.guest.error({ err, revocationId }, '[GuestClaim] revocation withdrawal failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to withdraw the revocation', 500);
  }
}
