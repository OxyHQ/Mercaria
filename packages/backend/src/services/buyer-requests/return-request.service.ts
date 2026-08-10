/**
 * The BUYER half of a return — filing one and withdrawing one (#110).
 *
 * The same wall as `cancellation-request.service.ts`: no order writer, no
 * refund service, no inventory function, nothing from the payment domain, and a
 * scanned gate that fails the build if that changes.
 *
 * ## The unit ceiling counts requests IN FLIGHT, not just completed ones
 *
 * "How much of this order is still returnable" has to subtract the units an
 * OPEN return is already bringing back, not only the ones a completed return
 * already did. Counting completed returns alone would let a buyer open a second
 * return for the same three shirts while the first three were in the post, and
 * a seller approving both would refund six. `sumReturnedQuantities` counts every
 * non-terminated request for exactly that reason.
 *
 * ## Evidence is DECLARED, and Mercaria validates nothing about the file
 *
 * A bare Oxy `file_id` the buyer already uploaded to their own Oxy storage —
 * the `abuse_reports` posture. Mercaria holds no Oxy service credential, so it
 * cannot read the file's metadata, cannot compute a digest and cannot scan it;
 * asserting any of the three would be worse than admitting it has none. The gap
 * is stated in `docs/buyer-requests.md` and it is the SAME one
 * `services/moderation/` documents — closing it closes both.
 */

import type { SubmitReturnRequestInput } from '@mercaria/shared-types';
import {
  BUYER_REQUEST_NOTE_MAX_LENGTH,
  RETURN_EVIDENCE_MAX_COUNT,
  SUPPORTED_RETURN_RESOLUTIONS,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import {
  findOpenReturnRequestForOrder,
  findReturnRequestById,
  findReturnRequestByIdempotencyKey,
  insertReturnRequest,
  listReturnRequestEvidence,
  listReturnRequestLines,
  listReturnRequestsForOrder,
  sumReturnedQuantities,
  transitionReturnRequest,
  type ReturnRequestRow,
} from '../../db/buyerRequests/returnRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { actorAuditColumns, type BuyerRequestActor } from './authorization.js';
import { notifyReturnReceived } from './notifications.js';
import { returnEligibilityWithOpenRequest } from './policy.js';
import { orderedQuantitiesByVariant, type BuyerRequestOrderContext } from './order-facts.js';

/** A request with its lines and its declared evidence. */
export interface ReturnRequestWithDetail {
  readonly request: ReturnRequestRow;
  readonly lines: Awaited<ReturnType<typeof listReturnRequestLines>>;
  readonly evidence: Awaited<ReturnType<typeof listReturnRequestEvidence>>;
}

/** Load a request, its lines and its evidence together. */
async function withDetail(request: ReturnRequestRow): Promise<ReturnRequestWithDetail> {
  const [lines, evidence] = await Promise.all([
    listReturnRequestLines(request.id),
    listReturnRequestEvidence(request.id),
  ]);
  return { request, lines, evidence };
}

/**
 * How many units of each variant a buyer could still return.
 *
 * Ordered minus everything an open or completed return already covers. Exposed
 * so the eligibility read and the submit path compute it the same way — two
 * spellings of a ceiling is how a buyer gets told they may return something the
 * submit then refuses.
 */
export async function returnableQuantities(
  context: BuyerRequestOrderContext,
): Promise<Map<string, number>> {
  const ordered = orderedQuantitiesByVariant(context.order);
  const alreadyReturning = await sumReturnedQuantities(context.order.id);
  const remaining = new Map<string, number>();
  for (const [variantId, quantity] of ordered) {
    const left = quantity - (alreadyReturning.get(variantId) ?? 0);
    if (left > 0) remaining.set(variantId, left);
  }
  return remaining;
}

/** File a return request. See `submitCancellationRequest` for the shared shape. */
export async function submitReturnRequest(input: {
  context: BuyerRequestOrderContext;
  actor: BuyerRequestActor;
  body: SubmitReturnRequestInput;
  idempotencyKey?: string;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const { context, actor, body } = input;

  if (input.idempotencyKey !== undefined) {
    const prior = await findReturnRequestByIdempotencyKey(input.idempotencyKey);
    if (prior) return withDetail(prior);
  }

  if (body.note !== undefined && body.note.length > BUYER_REQUEST_NOTE_MAX_LENGTH) {
    throw validationError('The note is too long');
  }
  if (body.lines.length === 0) {
    throw validationError('A return must name at least one line');
  }
  const evidence = body.evidence ?? [];
  if (evidence.length > RETURN_EVIDENCE_MAX_COUNT) {
    throw validationError('Too many evidence files');
  }

  // A resolution this deployment cannot carry out is refused HERE rather than at
  // approval, so a buyer is not told "yes" and then "actually no" a day later
  // by a seller who has no way to deliver it. `replacement` stays in the tuple
  // — see `RETURN_RESOLUTIONS` for why the value is kept.
  if (!SUPPORTED_RETURN_RESOLUTIONS.includes(body.resolution)) {
    throw validationError(
      `Mercaria cannot currently arrange a ${body.resolution}; ask for a refund instead`,
    );
  }

  const returnable = await returnableQuantities(context);
  const seen = new Set<string>();
  for (const line of body.lines) {
    const available = returnable.get(line.variantId);
    if (available === undefined) {
      throw validationError('A requested line is not part of this order, or is fully returned');
    }
    if (seen.has(line.variantId)) {
      throw validationError('A variant may appear only once in a request');
    }
    seen.add(line.variantId);
    if (line.quantity < 1 || line.quantity > available) {
      throw validationError('A requested quantity is more than is left to return');
    }
  }

  const open = await findOpenReturnRequestForOrder(context.order.id);
  const eligibility = returnEligibilityWithOpenRequest(
    context.policy,
    { hasOpenRequest: open !== undefined, hasReturnableUnits: returnable.size > 0 },
    input.now,
  );
  if (eligibility.verdict === 'ineligible') {
    if (eligibility.reason === 'request_already_open' && open) return withDetail(open);
    throw conflict(`This order cannot be returned: ${eligibility.reason}`);
  }

  const created = await getDb().transaction(async (tx) => {
    const row = await insertReturnRequest(tx, {
      orderId: context.order.id,
      reason: body.reason,
      resolution: body.resolution,
      ...(body.note === undefined ? {} : { note: body.note }),
      // The SNAPSHOT — #110 return field 9. A store shortening its window
      // tomorrow cannot close a return somebody filed today.
      returnWindowEndsAt: eligibility.windowEndsAt,
      requestedByActorKind: actor.kind,
      ...(actor.oxyUserId === undefined ? {} : { requestedByOxyUserId: actor.oxyUserId }),
      ...(actor.grantId === undefined ? {} : { requestedByGrantId: actor.grantId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      lines: body.lines.map((line) => ({
        variantId: line.variantId,
        requestedQuantity: line.quantity,
      })),
      evidence: evidence.map((item, position) => ({
        fileId: item.fileId,
        kind: item.kind,
        position,
      })),
    });
    if (!row) return null;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: row.id,
      kind: 'submitted',
      ...actorAuditColumns(actor),
      at: input.now,
    });
    return row;
  });

  if (!created) {
    const converged =
      (await findOpenReturnRequestForOrder(context.order.id)) ??
      (input.idempotencyKey === undefined
        ? undefined
        : await findReturnRequestByIdempotencyKey(input.idempotencyKey));
    if (converged) return withDetail(converged);
    throw conflict('This order already has a return request');
  }

  notifyReturnReceived(context.order, created.id);

  const stored = await findReturnRequestById(created.id);
  if (!stored) throw notFound('Return request not found');
  return withDetail(stored);
}

/**
 * Withdraw a return the buyer no longer wants.
 *
 * Only from `requested`, for the cancellation service's reason: once a seller
 * has approved, instructions exist and goods may be in the post.
 */
export async function withdrawReturnRequest(input: {
  requestId: string;
  actor: BuyerRequestActor;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state === 'withdrawn') return withDetail(existing);

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: 'requested',
      to: 'withdrawn',
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'withdrawn',
      ...actorAuditColumns(input.actor),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This request has already been decided');

  const stored = await findReturnRequestById(input.requestId);
  if (!stored) throw notFound('Return request not found');
  return withDetail(stored);
}

/** Every return filed against one order, newest first. */
export async function listReturnRequests(orderId: string): Promise<ReturnRequestWithDetail[]> {
  const requests = await listReturnRequestsForOrder(orderId);
  return Promise.all(requests.map(withDetail));
}

/** One return by id, with its lines and evidence. */
export async function getReturnRequest(requestId: string): Promise<ReturnRequestWithDetail> {
  const request = await findReturnRequestById(requestId);
  if (!request) throw notFound('Return request not found');
  return withDetail(request);
}
