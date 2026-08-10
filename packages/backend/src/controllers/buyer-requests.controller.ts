/**
 * The HTTP surface for buyer post-purchase requests (#110).
 *
 * ONE controller for both actor kinds, because there is nothing guest-shaped
 * below it — ADR 0003 I9, the rule #104's cart and #105's checkout already
 * follow. What differs between a guest and an Oxy buyer is which CREDENTIAL
 * arrives, and {@link buyerCredential} is the whole of that difference.
 *
 * ## Every buyer handler goes through `authorizeBuyerRequest`
 *
 * There is no path below that reaches a mutating service without one, and there
 * cannot be: those services take a `BuyerRequestActor`, which only
 * `authorizeBuyerRequest` can mint. So this file cannot forget a scope check —
 * it can only fail to compile.
 *
 * ## The refusal codes
 *
 * An order-access denial is 404, because "this order exists but is not yours"
 * is a fact about somebody else's purchase (#106's rule). A scope or step-up
 * denial is 403 with a message that says what to do, because the caller has
 * already demonstrated they hold the order and telling them their session is
 * too old discloses nothing. `denialIsAboutTheOrder` is the one place that
 * split is decided.
 */

import type { Request, Response } from 'express';
import type { ReturnEvidenceKind } from '@mercaria/shared-types';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { log } from '../lib/logger.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { config } from '../config/index.js';
import {
  authorizeBuyerRequest,
  denialIsAboutTheOrder,
  operatorDecisionActor,
  sellerDecisionActor,
  type BuyerRequestAction,
  type BuyerRequestActor,
  type BuyerRequestCredential,
  type BuyerRequestDecisionAction,
} from '../services/buyer-requests/authorization.js';
import {
  loadBuyerRequestOrder,
  readBuyerOrderRequestOptions,
  type BuyerRequestOrderContext,
} from '../services/buyer-requests/order-facts.js';
import {
  getCancellationRequest,
  listCancellationRequests,
  submitCancellationRequest,
  withdrawCancellationRequest,
} from '../services/buyer-requests/cancellation-request.service.js';
import {
  completeCancellationRequest,
  decideCancellationRequest,
  type CancellationDecisionInput,
} from '../services/buyer-requests/cancellation-decision.service.js';
import {
  getReturnRequest,
  listReturnRequests,
  submitReturnRequest,
  withdrawReturnRequest,
} from '../services/buyer-requests/return-request.service.js';
import {
  cancelReturnRequest,
  decideReturnRequest,
  issueReturnInstructions,
  markReturnReceived,
  refundReturnRequest,
  reconcileReturnRefund,
} from '../services/buyer-requests/return-decision.service.js';
import {
  closeSupportThread,
  postSupportMessage,
  readSupportThread,
  type SupportWriter,
} from '../services/buyer-requests/support.service.js';
import {
  toCancellationRequestView,
  toMerchantCancellationRequestView,
  toMerchantReturnRequestView,
  toReturnRequestView,
  toSupportThreadView,
} from '../services/buyer-requests/projection.js';
import { listBuyerRequestEvents } from '../db/buyerRequests/eventRepository.js';
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { buyerRequestBodySchemas } from './buyer-requests.schemas.js';

/* -------------------------------------------------------------------------- */
/*  Credential resolution                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The credential this request presented, or `null`.
 *
 * A portal grant wins when both are present, and deliberately: a person reading
 * their order through an emailed link, in a browser also signed in to somebody
 * else's Oxy account, is acting as the portal credential's owner. #106's
 * precedence rule is about the CART token, which resolves to no order subject
 * at all; this is the different question of which of two ORDER credentials to
 * use, and the one the caller demonstrably reached this page with is the honest
 * answer.
 */
function buyerCredential(req: Request): BuyerRequestCredential | null {
  if (req.portalGrant !== undefined) {
    return { kind: 'guest_portal', grant: req.portalGrant };
  }
  const oxyUserId = req.userId;
  if (typeof oxyUserId === 'string' && oxyUserId.length > 0) {
    return { kind: 'oxy_account', oxyUserId };
  }
  return null;
}

/** An authorized buyer plus the order they were authorized for, or a sent response. */
async function authorizedBuyer(
  req: Request,
  res: Response,
  orderId: string,
  action: BuyerRequestAction,
): Promise<{ actor: BuyerRequestActor; context: BuyerRequestOrderContext } | null> {
  const credential = buyerCredential(req);
  // No credential and a missing order answer the SAME 404, so an unauthenticated
  // caller cannot use this surface to test whether an order id exists.
  const context = credential === null ? null : await loadBuyerRequestOrder(orderId);
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
 * One path parameter as a string.
 *
 * This project's Express typings widen `req.params` to `string | string[]`
 * (a repeated `:id` in a mounted sub-router can genuinely produce an array), so
 * every read needs the narrowing. A repeated value takes the FIRST, which is
 * the outermost mount's — and every mount here supplies the same id, so the
 * choice is only reachable through a malformed request.
 */
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
function requestsAreOpen(res: Response): boolean {
  if (config.buyerRequests.requestsEnabled) return true;
  sendError(
    res,
    ErrorCodes.BUYER_REQUESTS_DISABLED,
    'New requests are temporarily unavailable; existing ones are unaffected',
    503,
  );
  return false;
}


/**
 * Zod's parse guarantee is invisible to this compiler.
 *
 * With `strictNullChecks` off, `z.infer` marks every property optional — so a
 * successfully parsed body still does not type-check against an input whose
 * fields are required. Casting past that would be asserting something the
 * compiler genuinely cannot see; re-reading the required field and refusing
 * `undefined` restores the guarantee at the only cost that matters, which is
 * four lines.
 */
function required<T>(value: T | undefined, res: Response, message: string): T | null {
  if (value === undefined) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, message, 400);
    return null;
  }
  return value;
}

/** Parsed lines, with the same `strictNullChecks` narrowing as {@link required}. */
function requiredLines(
  lines: { variantId?: string; quantity?: number }[],
): { variantId: string; quantity: number }[] {
  // The schema already refuses a line missing either field, so the fallbacks
  // below are unreachable — they exist because the compiler cannot see that,
  // and an empty variant id fails the service's own order-membership check
  // rather than being silently accepted.
  return lines.map((line) => ({ variantId: line.variantId ?? '', quantity: line.quantity ?? 0 }));
}

/** Parsed evidence, narrowed the same way. */
function requiredEvidence(
  evidence: { fileId?: string; kind?: ReturnEvidenceKind }[],
): { fileId: string; kind: ReturnEvidenceKind }[] {
  return evidence.map((item) => ({
    fileId: item.fileId ?? '',
    kind: item.kind ?? 'other_photo',
  }));
}

/**
 * A decision body with its one required field re-asserted.
 *
 * Returns the SERVICE's input type rather than the schema's inferred one:
 * `z.infer` marks `decision` optional under `strictNullChecks: false`, so
 * returning that shape would push the same unassignable type one call further
 * along. `CancellationDecisionInput` and `ReturnDecisionInput` are structurally
 * identical, so one narrowing serves both deciders.
 */
function decisionBody(
  data: {
    decision?: 'accept' | 'reject';
    note?: string;
    lines?: { variantId?: string; quantity?: number }[];
  },
  res: Response,
): CancellationDecisionInput | null {
  const decision = required(data.decision, res, 'A decision is required');
  if (decision === null) return null;
  return {
    decision,
    ...(data.note === undefined ? {} : { note: data.note }),
    ...(data.lines === undefined ? {} : { lines: requiredLines(data.lines) }),
  };
}

/** Wrap an async handler so a rejection becomes a response, never a hang. */
function handleAs(
  fallback: string,
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    void fn(req, res).catch((err: unknown) => {
      log.general.error({ err, path: req.path }, `[BuyerRequests] ${fallback}`);
      respondWithError(res, err, fallback);
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Buyer handlers                                                             */
/* -------------------------------------------------------------------------- */

/** `GET /orders/:id/request-options` — what may this buyer ask for right now. */
export const getRequestOptions = handleAs('Failed to read what may be requested', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'request:read');
  if (!authorized) return;
  // Whether the credential could WRITE into a support thread is a scope
  // question, answered by asking the authorizer rather than by re-reading the
  // grant here — one source for a scope decision.
  const credential = buyerCredential(req);
  const supportAvailable =
    credential !== null &&
    authorizeBuyerRequest({
      credential,
      order: authorized.context.access,
      action: 'support:write',
      now: new Date(),
    }).outcome === 'authorized';
  sendSuccess(
    res,
    await readBuyerOrderRequestOptions(authorized.context, { supportAvailable }, new Date()),
  );
});

/** `POST /orders/:id/cancellation-requests` — ask for an order to be undone. */
export const createCancellationRequest = handleAs('Failed to file the cancellation request', async (req, res) => {
  if (!requestsAreOpen(res)) return;
  const parsed = buyerRequestBodySchemas.submitCancellation.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A valid reason is required', 400);
    return;
  }
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'cancellation:submit');
  if (!authorized) return;

  const reason = required(parsed.data.reason, res, 'A valid reason is required');
  if (reason === null) return;
  const key = idempotencyKey(req);
  const result = await submitCancellationRequest({
    context: authorized.context,
    actor: authorized.actor,
    body: {
      reason,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      ...(parsed.data.lines === undefined ? {} : { lines: requiredLines(parsed.data.lines) }),
    },
    ...(key === undefined ? {} : { idempotencyKey: key }),
    now: new Date(),
  });
  // AFTER the write succeeded, so the metric counts requests that were FILED
  // rather than requests that were attempted — `guest_post_purchase_demand`'s
  // numerator is demand, and a refused submission is not demand this domain
  // met.
  emitAnalyticsEvent(req, {
    eventType: 'guest_cancellation_requested',
    buyerOrigin: authorized.actor.kind === 'guest' ? 'guest' : 'authenticated',
    orderId: authorized.context.order.id,
  });
  sendSuccess(res, toCancellationRequestView(result.request, result.lines), 201);
});

/** `POST /orders/:id/cancellation-requests/:requestId/withdraw`. */
export const withdrawCancellation = handleAs('Failed to withdraw the cancellation request', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'cancellation:withdraw');
  if (!authorized) return;
  const requestId = await scopedRequestId(req, res, 'cancellation');
  if (requestId === null) return;
  const result = await withdrawCancellationRequest({
    requestId,
    actor: authorized.actor,
    now: new Date(),
  });
  sendSuccess(res, toCancellationRequestView(result.request, result.lines));
});

/** `GET /orders/:id/cancellation-requests`. */
export const listCancellations = handleAs('Failed to list cancellation requests', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'request:read');
  if (!authorized) return;
  const requests = await listCancellationRequests(authorized.context.order.id);
  sendSuccess(
    res,
    requests.map((entry) => toCancellationRequestView(entry.request, entry.lines)),
  );
});

/** `POST /orders/:id/return-requests` — ask to send goods back. */
export const createReturnRequest = handleAs('Failed to file the return request', async (req, res) => {
  if (!requestsAreOpen(res)) return;
  const parsed = buyerRequestBodySchemas.submitReturn.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A valid return request is required', 400);
    return;
  }
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'return:submit');
  if (!authorized) return;

  const reason = required(parsed.data.reason, res, 'A valid reason is required');
  if (reason === null) return;
  const resolution = required(parsed.data.resolution, res, 'A resolution is required');
  if (resolution === null) return;
  const lines = required(parsed.data.lines, res, 'A return must name at least one line');
  if (lines === null) return;
  const key = idempotencyKey(req);
  const result = await submitReturnRequest({
    context: authorized.context,
    actor: authorized.actor,
    body: {
      reason,
      resolution,
      lines: requiredLines(lines),
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      ...(parsed.data.evidence === undefined
        ? {}
        : { evidence: requiredEvidence(parsed.data.evidence) }),
    },
    ...(key === undefined ? {} : { idempotencyKey: key }),
    now: new Date(),
  });
  emitAnalyticsEvent(req, {
    eventType: 'guest_return_requested',
    buyerOrigin: authorized.actor.kind === 'guest' ? 'guest' : 'authenticated',
    orderId: authorized.context.order.id,
  });
  sendSuccess(res, toReturnRequestView(result.request, result.lines, result.evidence), 201);
});

/** `POST /orders/:id/return-requests/:requestId/withdraw`. */
export const withdrawReturn = handleAs('Failed to withdraw the return request', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'return:withdraw');
  if (!authorized) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const result = await withdrawReturnRequest({
    requestId,
    actor: authorized.actor,
    now: new Date(),
  });
  sendSuccess(res, toReturnRequestView(result.request, result.lines, result.evidence));
});

/** `GET /orders/:id/return-requests`. */
export const listReturns = handleAs('Failed to list return requests', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'request:read');
  if (!authorized) return;
  const requests = await listReturnRequests(authorized.context.order.id);
  sendSuccess(
    res,
    requests.map((entry) => toReturnRequestView(entry.request, entry.lines, entry.evidence)),
  );
});

/** `GET /orders/:id/support` — the order's support thread, if there is one. */
export const readBuyerSupportThread = handleAs('Failed to read the support thread', async (req, res) => {
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'request:read');
  if (!authorized) return;
  const thread = await readSupportThread({ orderId: authorized.context.order.id });
  sendSuccess(res, thread === null ? null : toSupportThreadView(thread.thread, thread.messages));
});

/** `POST /orders/:id/support` — write into it. */
export const postBuyerSupportMessage = handleAs('Failed to post the support message', async (req, res) => {
  if (!requestsAreOpen(res)) return;
  const parsed = buyerRequestBodySchemas.supportMessage.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A message body is required', 400);
    return;
  }
  const authorized = await authorizedBuyer(req, res, pathParam(req, 'id'), 'support:write');
  if (!authorized) return;

  const messageBody = required(parsed.data.body, res, 'A message body is required');
  if (messageBody === null) return;
  const result = await postSupportMessage({
    subject: {
      orderId: authorized.context.order.id,
      ...(parsed.data.returnRequestId === undefined
        ? {}
        : { returnRequestId: parsed.data.returnRequestId }),
    },
    writer: { side: 'buyer', actor: authorized.actor },
    body: messageBody,
  });
  emitAnalyticsEvent(req, {
    eventType: 'guest_support_request_created',
    buyerOrigin: authorized.actor.kind === 'guest' ? 'guest' : 'authenticated',
    orderId: authorized.context.order.id,
  });
  sendSuccess(res, toSupportThreadView(result.thread, result.messages), 201);
});

/**
 * The request id from the path, checked to belong to the order in the path.
 *
 * A request id is a bare identifier and the order is what authorization was
 * decided on, so accepting one without tying it to the other would let a
 * credential for order A act on a request filed against order B — authorization
 * rule 5, and the exact shape a sibling-order leak takes.
 */
async function scopedRequestId(
  req: Request,
  res: Response,
  kind: 'cancellation' | 'return',
): Promise<string | null> {
  const orderId = pathParam(req, 'id');
  const requestId = pathParam(req, 'requestId');
  const request =
    kind === 'cancellation'
      ? await getCancellationRequest(requestId)
      : await getReturnRequest(requestId);
  if (request.request.orderId !== orderId) {
    // A 404 rather than a 400: the id exists and belongs to somebody else's
    // order, which is not a fact this surface may confirm. Returned as `null`
    // rather than thrown, so the caller stops and the wrapper never writes a
    // second response over this one.
    sendError(res, ErrorCodes.NOT_FOUND, 'Request not found', 404);
    return null;
  }
  return requestId;
}

/* -------------------------------------------------------------------------- */
/*  Merchant handlers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A merchant decider, scoped to the store the router already verified.
 *
 * The ORDER is re-checked against that store here: `requireStorePermission`
 * proves the caller may act for the store, and this proves the order belongs to
 * it. #106 keeps those two questions apart for exactly this reason, and folding
 * them would put a permission matrix in the request domain.
 */
async function merchantContext(
  req: Request,
  res: Response,
  action: BuyerRequestDecisionAction,
): Promise<{ decider: ReturnType<typeof sellerDecisionActor>; orderId: string } | null> {
  const storeId = pathParam(req, 'storeId');
  const orderId = pathParam(req, 'id');
  const context = await loadBuyerRequestOrder(orderId);
  if (!context || context.order.storeId !== storeId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return null;
  }
  return { decider: sellerDecisionActor(req.userId ?? '', action), orderId };
}

/** `GET /admin/stores/:storeId/orders/:id/buyer-requests` — the merchant queue. */
export const listMerchantRequests = handleAs('Failed to list buyer requests', async (req, res) => {
  const merchant = await merchantContext(req, res, 'support:reply');
  if (!merchant) return;
  const [cancellations, returns, support] = await Promise.all([
    listCancellationRequests(merchant.orderId),
    listReturnRequests(merchant.orderId),
    readSupportThread({ orderId: merchant.orderId }),
  ]);
  sendSuccess(res, {
    cancellations: cancellations.map((entry) =>
      toMerchantCancellationRequestView(entry.request, entry.lines),
    ),
    returns: returns.map((entry) =>
      toMerchantReturnRequestView(entry.request, entry.lines, entry.evidence),
    ),
    support: support === null ? null : toSupportThreadView(support.thread, support.messages),
  });
});

/** `POST …/cancellation-requests/:requestId/decision`. */
export const decideCancellation = handleAs('Failed to decide the cancellation request', async (req, res) => {
  const parsed = buyerRequestBodySchemas.decision.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A decision is required', 400);
    return;
  }
  const merchant = await merchantContext(req, res, 'cancellation:decide');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'cancellation');
  if (requestId === null) return;
  const body = decisionBody(parsed.data, res);
  if (body === null) return;
  const result = await decideCancellationRequest({
    requestId,
    decider: merchant.decider,
    body,
    now: new Date(),
  });
  sendSuccess(res, toMerchantCancellationRequestView(result.request, result.lines));
});

/** `POST …/cancellation-requests/:requestId/complete` — retry a failed completion. */
export const completeCancellation = handleAs('Failed to complete the cancellation', async (req, res) => {
  const merchant = await merchantContext(req, res, 'cancellation:complete');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'cancellation');
  if (requestId === null) return;
  const result = await completeCancellationRequest({
    requestId,
    decider: merchant.decider,
    now: new Date(),
  });
  sendSuccess(res, toMerchantCancellationRequestView(result.request, result.lines));
});

/** `POST …/return-requests/:requestId/decision`. */
export const decideReturn = handleAs('Failed to decide the return request', async (req, res) => {
  const parsed = buyerRequestBodySchemas.decision.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A decision is required', 400);
    return;
  }
  const merchant = await merchantContext(req, res, 'return:decide');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const body = decisionBody(parsed.data, res);
  if (body === null) return;
  const result = await decideReturnRequest({
    requestId,
    decider: merchant.decider,
    body,
    now: new Date(),
  });
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});

/** `POST …/return-requests/:requestId/instructions`. */
export const instructReturn = handleAs('Failed to issue return instructions', async (req, res) => {
  const parsed = buyerRequestBodySchemas.instructions.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Return instructions are required', 400);
    return;
  }
  const merchant = await merchantContext(req, res, 'return:instruct');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const instructions = required(parsed.data.instructions, res, 'Return instructions are required');
  if (instructions === null) return;
  const result = await issueReturnInstructions({
    requestId,
    decider: merchant.decider,
    instructions,
    ...(parsed.data.shipBackDeadlineAt === undefined
      ? {}
      : { shipBackDeadlineAt: new Date(parsed.data.shipBackDeadlineAt) }),
    now: new Date(),
  });
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});

/** `POST …/return-requests/:requestId/received`. */
export const receiveReturn = handleAs('Failed to record the return as received', async (req, res) => {
  const merchant = await merchantContext(req, res, 'return:receive');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const result = await markReturnReceived({
    requestId,
    decider: merchant.decider,
    now: new Date(),
  });
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});

/** `POST …/return-requests/:requestId/refund` — commit the money. */
export const refundReturn = handleAs('Failed to refund the return', async (req, res) => {
  const merchant = await merchantContext(req, res, 'return:refund');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const result = await refundReturnRequest({
    requestId,
    decider: merchant.decider,
    now: new Date(),
  });
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});

/** `POST …/return-requests/:requestId/cancel` — the seller calls it off. */
export const cancelReturn = handleAs('Failed to cancel the return', async (req, res) => {
  const parsed = buyerRequestBodySchemas.decision.safeParse(req.body);
  if (!parsed.success || (parsed.data.note ?? '').trim().length < 3) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Say why the return was cancelled', 400);
    return;
  }
  const merchant = await merchantContext(req, res, 'return:decide');
  if (!merchant) return;
  const requestId = await scopedRequestId(req, res, 'return');
  if (requestId === null) return;
  const result = await cancelReturnRequest({
    requestId,
    decider: merchant.decider,
    note: parsed.data.note ?? '',
    now: new Date(),
  });
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});

/** `POST /admin/stores/:storeId/orders/:id/support` — the seller replies. */
export const postMerchantSupportMessage = handleAs('Failed to post the support message', async (req, res) => {
  const parsed = buyerRequestBodySchemas.supportMessage.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A message body is required', 400);
    return;
  }
  const merchant = await merchantContext(req, res, 'support:reply');
  if (!merchant) return;
  const messageBody = required(parsed.data.body, res, 'A message body is required');
  if (messageBody === null) return;
  const writer: SupportWriter = { side: 'seller', decider: merchant.decider };
  const result = await postSupportMessage({
    subject: {
      orderId: merchant.orderId,
      ...(parsed.data.returnRequestId === undefined
        ? {}
        : { returnRequestId: parsed.data.returnRequestId }),
    },
    writer,
    body: messageBody,
  });
  sendSuccess(res, toSupportThreadView(result.thread, result.messages), 201);
});

/** `POST /admin/stores/:storeId/orders/:id/support/close`. */
export const closeMerchantSupportThread = handleAs('Failed to close the support thread', async (req, res) => {
  const merchant = await merchantContext(req, res, 'support:reply');
  if (!merchant) return;
  const thread = await readSupportThread({ orderId: merchant.orderId });
  if (thread === null) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Support thread not found', 404);
    return;
  }
  const result = await closeSupportThread({ threadId: thread.thread.id, now: new Date() });
  sendSuccess(res, toSupportThreadView(result.thread, result.messages));
});

/* -------------------------------------------------------------------------- */
/*  Operator handlers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `GET /internal/guest-commerce/buyer-requests/:orderId` — the audited trace.
 *
 * Opens from an ORDER and nothing else: no email, no request id alone, no
 * checkout group and no session. "Show me everything this person ever asked
 * for" is not a question this surface can be asked, which is the shape #50's
 * five handles and #77's two already have.
 */
export const traceBuyerRequests = handleAs('Failed to trace the buyer requests', async (req, res) => {
  const orderId = pathParam(req, 'orderId');
  const context = await loadBuyerRequestOrder(orderId);
  if (!context) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  const [cancellations, returns, support] = await Promise.all([
    listCancellationRequests(orderId),
    listReturnRequests(orderId),
    readSupportThread({ orderId }),
  ]);
  const timelines = await Promise.all([
    ...cancellations.map(async (entry) => ({
      requestId: entry.request.id,
      kind: 'cancellation' as const,
      events: await listBuyerRequestEvents({ cancellationRequestId: entry.request.id }),
    })),
    ...returns.map(async (entry) => ({
      requestId: entry.request.id,
      kind: 'return' as const,
      events: await listBuyerRequestEvents({ returnRequestId: entry.request.id }),
    })),
  ]);
  sendSuccess(res, {
    orderId,
    cancellations: cancellations.map((entry) =>
      toMerchantCancellationRequestView(entry.request, entry.lines),
    ),
    returns: returns.map((entry) =>
      toMerchantReturnRequestView(entry.request, entry.lines, entry.evidence),
    ),
    support: support === null ? null : toSupportThreadView(support.thread, support.messages),
    timelines,
  });
});

/**
 * `POST /internal/guest-commerce/buyer-requests/:requestId/reconcile`.
 *
 * The ONE operator write, and it drives an existing idempotent path — the
 * `payment_repairs` posture, which is why this surface adds a TRIGGER and no
 * new way to move money. There is deliberately no "set this request completed",
 * no "override this decision" and no "delete this thread".
 */
export const reconcileBuyerRequest = handleAs('Failed to reconcile the return refund', async (req, res) => {
  const operator = operatorDecisionActor(
    getRequiredOxyUserId(req),
    'return:refund',
  );
  const result = await reconcileReturnRefund({
    requestId: pathParam(req, 'requestId'),
    now: new Date(),
  });
  log.general.info(
    { actor: operator.oxyUserId, requestId: result.request.id, state: result.request.state },
    '[BuyerRequests] operator reconciled a return refund',
  );
  sendSuccess(res, toMerchantReturnRequestView(result.request, result.lines, result.evidence));
});
