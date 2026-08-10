/**
 * The HTTP surface for retail cancellations, returns and warranty claims
 * (#127).
 *
 * ONE controller for both actor kinds, because there is nothing guest-shaped
 * below it — ADR 0003 I9, and #127 responsibility rule 7 (*"guest buyers receive
 * the same supported rights without creating an Oxy account"*) is that rule
 * meeting this issue. What differs between a guest and an Oxy buyer is which
 * CREDENTIAL arrives, and {@link retailBuyerCredential} is the whole of it.
 *
 * ## Every buyer handler goes through `authorizeBuyerRequest`
 *
 * #110's, unchanged — there is no path below that reaches a mutating service
 * without one, and there cannot be: those services take a `BuyerRequestActor`,
 * which only that function can mint. So this file cannot forget a scope check;
 * it can only fail to compile.
 *
 * ## The refusal codes
 *
 * An order-access denial is 404, because "this order exists but is not yours" is
 * a fact about somebody else's purchase. A scope or step-up denial is 403 with a
 * message saying what to do, because the caller has already demonstrated they
 * hold the order. `denialIsAboutTheOrder` is the one place that split is decided.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  RETAIL_SERVICE_EVIDENCE_KINDS,
  RETAIL_SERVICE_EVIDENCE_MAX_COUNT,
  RETAIL_SERVICE_NOTE_MAX_LENGTH,
  RETAIL_SERVICE_REQUEST_KINDS,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import {
  authorizeBuyerRequest,
  denialIsAboutTheOrder,
  type BuyerRequestAction,
  type BuyerRequestActor,
  type BuyerRequestCredential,
} from '../services/buyer-requests/authorization.js';
import {
  loadRetailServiceOrder,
  type RetailServiceOrderContext,
} from '../services/retail-service-requests/order-facts.js';
import { retailRequestAction } from '../services/retail-service-requests/request-kinds.js';
import {
  attachRetailServiceEvidence,
  evaluateRetailRequestEligibility,
  listRetailServiceRequests,
  submitRetailServiceRequest,
  withdrawRetailServiceRequest,
} from '../services/retail-service-requests/request.service.js';
import { projectRetailServiceRequestForCustomer } from '../services/retail-service-requests/projection.js';
import { findRetailServiceRequest } from '../db/retailServiceRequests/requestRepository.js';

/**
 * The `.strict()` submit body.
 *
 * Strict because a body able to carry a money word is where one would eventually
 * be trusted — #107's `checkoutSchema` reasoning. There is no `amount`, no
 * `outcome`, no `refund` and no `state` here, so a client cannot propose what
 * Mercaria owes them; the only things a buyer supplies are WHICH lines, HOW MANY
 * units, WHY and their own evidence.
 */
const submitSchema = z
  .object({
    kind: z.enum(RETAIL_SERVICE_REQUEST_KINDS),
    lines: z
      .array(
        z
          .object({
            orderItemId: z.string().min(1),
            quantity: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    customerNote: z.string().min(1).max(RETAIL_SERVICE_NOTE_MAX_LENGTH).optional(),
    evidence: z
      .array(
        z
          .object({
            fileId: z.string().min(1),
            kind: z.enum(RETAIL_SERVICE_EVIDENCE_KINDS),
            caption: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(RETAIL_SERVICE_EVIDENCE_MAX_COUNT)
      .optional(),
  })
  .strict();

/** The `.strict()` evidence body. */
const evidenceSchema = z
  .object({
    evidence: z
      .array(
        z
          .object({
            fileId: z.string().min(1),
            kind: z.enum(RETAIL_SERVICE_EVIDENCE_KINDS),
            caption: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(RETAIL_SERVICE_EVIDENCE_MAX_COUNT),
  })
  .strict();

/** The credential this request presented, or `null`. #110's precedence. */
function retailBuyerCredential(req: Request): BuyerRequestCredential | null {
  if (req.portalGrant !== undefined) {
    return { kind: 'guest_portal', grant: req.portalGrant };
  }
  const oxyUserId = req.userId;
  if (typeof oxyUserId === 'string' && oxyUserId.length > 0) {
    return { kind: 'oxy_account', oxyUserId };
  }
  return null;
}

/** One path parameter as a string — this project's params widen to arrays. */
function pathParam(req: Request, name: string): string {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? '';
}

/** The `Idempotency-Key` header, when the client sent one. */
function idempotencyKey(req: Request): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Refuse a buyer WRITE while the incident lever is down. Reads stay open. */
function retailRequestsAreOpen(res: Response): boolean {
  if (config.retailService.requestsEnabled) return true;
  sendError(
    res,
    ErrorCodes.BUYER_REQUESTS_DISABLED,
    'New requests are temporarily unavailable; existing ones are unaffected',
    503,
  );
  return false;
}

/** An authorized buyer plus the order they were authorized for, or a sent response. */
async function authorizedRetailBuyer(
  req: Request,
  res: Response,
  orderId: string,
  action: BuyerRequestAction,
): Promise<{ actor: BuyerRequestActor; context: RetailServiceOrderContext } | null> {
  const credential = retailBuyerCredential(req);
  // No credential and a missing order answer the SAME 404, so an unauthenticated
  // caller cannot use this surface to test whether an order id exists.
  const context = credential === null ? null : await loadRetailServiceOrder(orderId);
  if (credential === null || context === null) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return null;
  }

  const decision = authorizeBuyerRequest({
    credential,
    order: context.access,
    action,
    now: new Date(),
  });
  if (decision.outcome === 'refused') {
    if (denialIsAboutTheOrder(decision.reason)) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
      return null;
    }
    sendError(
      res,
      ErrorCodes.FORBIDDEN,
      decision.reason === 'step_up_required'
        ? 'Confirm your email address again before making this request'
        : 'This session cannot make that request',
      403,
    );
    return null;
  }
  return { actor: decision.actor, context };
}

/**
 * `GET …/retail-requests/options` — what may be asked for, and by when.
 *
 * The same derivation the submit path re-runs, so a button that exists cannot
 * then 409. It is a PROJECTION and never an authorization: the submit path does
 * not trust a client that read it.
 */
export async function getRetailRequestOptions(req: Request, res: Response): Promise<void> {
  try {
    const orderId = pathParam(req, 'id');
    const authorized = await authorizedRetailBuyer(req, res, orderId, 'request:read');
    if (authorized === null) return;

    const now = new Date();
    const options = [];
    for (const kind of RETAIL_SERVICE_REQUEST_KINDS) {
      if (retailRequestAction(kind, 'submit') === null) continue;
      const eligibility = await evaluateRetailRequestEligibility(authorized.context, {
        kind,
        // Every line of the order, which is the question "could I ask for this
        // at all" rather than "may I ask for these units" — the submit path
        // asks the second with the buyer's actual selection.
        lines: authorized.context.order.items.map((item) => ({
          orderItemId: item.id,
          quantity: item.quantity,
        })),
        hasEvidence: false,
        now,
      });
      options.push(
        eligibility.verdict === 'eligible'
          ? {
              kind,
              available: true,
              deadlineAt: eligibility.deadlineAt?.toISOString(),
            }
          : eligibility.verdict === 'evidence_needed'
            ? { kind, available: true, evidenceRequired: true }
            : { kind, available: false, reason: eligibility.reason },
      );
    }
    sendSuccess(res, { orderId, options });
  } catch (error) {
    respondWithError(res, error, 'Failed to read the request options');
  }
}

/** `GET …/retail-requests` — every request on this order. */
export async function listRetailRequests(req: Request, res: Response): Promise<void> {
  try {
    const orderId = pathParam(req, 'id');
    const authorized = await authorizedRetailBuyer(req, res, orderId, 'request:read');
    if (authorized === null) return;

    const records = await listRetailServiceRequests(orderId);
    const views = [];
    for (const record of records) {
      views.push(
        await projectRetailServiceRequestForCustomer(record, authorized.context.order),
      );
    }
    sendSuccess(res, views);
  } catch (error) {
    respondWithError(res, error, 'Failed to list the requests');
  }
}

/** `POST …/retail-requests` — file one. */
export async function createRetailRequest(req: Request, res: Response): Promise<void> {
  try {
    if (!retailRequestsAreOpen(res)) return;
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const kind = parsed.data.kind;
    if (kind === undefined) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A request kind is required', 400);
      return;
    }
    const action = retailRequestAction(kind, 'submit');
    if (action === null) {
      // The kind exists and a buyer may not raise it — a recall, a
      // return-to-sender, a chargeback coordination. Refused BEFORE any lookup,
      // so an invented order id leaks nothing.
      sendError(
        res,
        ErrorCodes.FORBIDDEN,
        'That kind of case is opened by Mercaria, not by a buyer',
        403,
      );
      return;
    }

    const orderId = pathParam(req, 'id');
    const authorized = await authorizedRetailBuyer(req, res, orderId, action);
    if (authorized === null) return;

    const record = await submitRetailServiceRequest(
      authorized.actor,
      {
        orderId,
        kind,
        lines: (parsed.data.lines ?? []).map((line) => ({
          orderItemId: line.orderItemId ?? '',
          quantity: line.quantity ?? 0,
        })),
        ...(parsed.data.customerNote === undefined
          ? {}
          : { customerNote: parsed.data.customerNote }),
        ...(parsed.data.evidence === undefined
          ? {}
          : {
              evidence: parsed.data.evidence.map((item) => ({
                fileId: item.fileId ?? '',
                kind: item.kind ?? 'photo',
                ...(item.caption === undefined ? {} : { caption: item.caption }),
              })),
            }),
        ...(idempotencyKey(req) === undefined ? {} : { idempotencyKey: idempotencyKey(req) }),
      },
      new Date(),
    );
    sendSuccess(
      res,
      await projectRetailServiceRequestForCustomer(record, authorized.context.order),
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to file the request');
  }
}

/** `POST …/retail-requests/:requestId/evidence` — attach what was asked for. */
export async function addRetailRequestEvidence(req: Request, res: Response): Promise<void> {
  try {
    if (!retailRequestsAreOpen(res)) return;
    const parsed = evidenceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const requestId = pathParam(req, 'requestId');
    const existing = await findRetailServiceRequest(requestId);
    if (!existing) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Request not found', 404);
      return;
    }
    const action = retailRequestAction(existing.kind, 'submit');
    if (action === null) {
      sendError(res, ErrorCodes.FORBIDDEN, 'This case is not yours to add to', 403);
      return;
    }
    const authorized = await authorizedRetailBuyer(req, res, existing.orderId, action);
    if (authorized === null) return;

    const record = await attachRetailServiceEvidence(authorized.actor, {
      requestId,
      evidence: (parsed.data.evidence ?? []).map((item) => ({
        fileId: item.fileId ?? '',
        kind: item.kind ?? 'photo',
        ...(item.caption === undefined ? {} : { caption: item.caption }),
      })),
    });
    sendSuccess(res, await projectRetailServiceRequestForCustomer(record, authorized.context.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to attach the evidence');
  }
}

/**
 * `POST …/retail-requests/:requestId/withdraw` — the buyer's own undo.
 *
 * No step-up: an email round trip between a buyer and the undo of their own
 * mistake is worse than useless, and the undo is the safe direction (#110's
 * reasoning, unchanged).
 */
export async function withdrawRetailRequest(req: Request, res: Response): Promise<void> {
  try {
    const requestId = pathParam(req, 'requestId');
    const existing = await findRetailServiceRequest(requestId);
    if (!existing) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Request not found', 404);
      return;
    }
    const action = retailRequestAction(existing.kind, 'withdraw');
    if (action === null) {
      sendError(res, ErrorCodes.FORBIDDEN, 'This case is not yours to withdraw', 403);
      return;
    }
    const authorized = await authorizedRetailBuyer(req, res, existing.orderId, action);
    if (authorized === null) return;

    const record = await withdrawRetailServiceRequest(authorized.actor, requestId, new Date());
    sendSuccess(res, await projectRetailServiceRequestForCustomer(record, authorized.context.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to withdraw the request');
  }
}
