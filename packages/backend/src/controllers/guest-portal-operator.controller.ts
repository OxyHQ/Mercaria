/**
 * The guest portal's operator handlers (#108 recovery rule 8, ADR 0003 T15).
 *
 * Behind `requireGuestOperator` — the SAME `GUEST_OPERATOR_OXY_USER_IDS`
 * allow-list #104's diagnostic uses, and deliberately not a seventh list.
 * Reading who could reach which checkout group and re-sending a link to the
 * stored contact is the same power class as reading who merged which cart: a
 * guest-commerce support question, answered without seeing what anyone bought
 * or who they are.
 *
 * ## What these handlers cannot be asked
 *
 * Every route opens from a CHECKOUT GROUP. There is no parameter for an email,
 * a hash, an order number or a session id, so "everything this inbox has ever
 * accessed" has no request shape — the payment trace's five-handle rule and the
 * analytics trace's two, applied to a third surface.
 *
 * ## Why a `reason` is mandatory
 *
 * `payment_repairs` again: an audit row with no reason records that something
 * happened and not why, which is the half nobody can act on months later. The
 * schema requires it, the CHECK requires at least three characters, and a
 * refused attempt records it too.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { log } from '../lib/logger.js';
import { routeParam } from '../utils/request.js';
import {
  resendGuestAccessLink,
  revokeGuestGroupAccess,
  traceGuestPortalAccess,
} from '../services/guest-portal/operator.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';

/**
 * `.strict()`, and note what it does NOT admit: an address, a scope, an expiry
 * or a grant id. An operator can trigger a send and cannot shape one.
 */
const operatorActionSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** GET /internal/guest-portal/checkouts/:checkoutGroupId — the access trace. */
export async function traceGuestPortalHandler(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.…`: Express types a param as
  // `string | string[]`, and a checkout group is a single value.
  const checkoutGroupId = routeParam(req, 'checkoutGroupId');
  try {
    const trace = await traceGuestPortalAccess(checkoutGroupId);
    if (trace === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No guest checkout for that group', 404);
      return;
    }
    sendSuccess(res, trace);
  } catch (err) {
    log.guest.error({ err, checkoutGroupId }, '[GuestPortal] operator trace failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to trace portal access', 500);
  }
}

/**
 * POST /internal/guest-portal/checkouts/:checkoutGroupId/resend-access-link
 *
 * Queues a link to the address already on the checkout. There is no destination
 * field in the schema, so rerouting one is unrepresentable rather than refused
 * (T15).
 */
export async function resendGuestAccessLinkHandler(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.…`: Express types a param as
  // `string | string[]`, and a checkout group is a single value.
  const checkoutGroupId = routeParam(req, 'checkoutGroupId');
  const parsed = operatorActionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A reason of at least 3 characters is required', 400);
    return;
  }

  try {
    const result = await resendGuestAccessLink({
      checkoutGroupId,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: parsed.data.reason,
      now: new Date(),
    });
    if (result.status === 'refused') {
      // The refusal CODE is returned, because the operator is an identified,
      // allow-listed person acting on a group they already named — there is no
      // enumeration to protect against here, and "it did not send" without a
      // reason is the answer that generates a second support ticket.
      sendError(res, ErrorCodes.CONFLICT, `Cannot send: ${result.refusal}`, 409);
      return;
    }
    sendSuccess(res, { queued: true }, 202);
  } catch (err) {
    log.guest.error({ err, checkoutGroupId }, '[GuestPortal] operator re-send failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to queue an access link', 500);
  }
}

/**
 * POST /internal/guest-portal/checkouts/:checkoutGroupId/revoke-access
 *
 * Revokes every live credential for the group, sparing none — an operator holds
 * none, and keeping one would mean an employee's session outlived a revocation
 * the buyer asked for.
 */
export async function revokeGuestGroupAccessHandler(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.…`: Express types a param as
  // `string | string[]`, and a checkout group is a single value.
  const checkoutGroupId = routeParam(req, 'checkoutGroupId');
  const parsed = operatorActionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A reason of at least 3 characters is required', 400);
    return;
  }

  try {
    const result = await revokeGuestGroupAccess({
      checkoutGroupId,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: parsed.data.reason,
      now: new Date(),
    });
    if (result.status === 'refused') {
      sendError(res, ErrorCodes.NOT_FOUND, 'No guest checkout for that group', 404);
      return;
    }
    sendSuccess(res, { revokedGrantIds: result.revokedGrantIds ?? [] });
  } catch (err) {
    log.guest.error({ err, checkoutGroupId }, '[GuestPortal] operator revoke failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to revoke access', 500);
  }
}
