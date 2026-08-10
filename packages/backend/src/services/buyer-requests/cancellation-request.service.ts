/**
 * The BUYER half of a cancellation — filing one and withdrawing one (#110).
 *
 * ## This module cannot change an order, and the import graph is the proof
 *
 * It imports no order writer, no refund service, no inventory function and
 * nothing from the payment domain; `buyer-request-isolation.test.ts` fails the
 * build if it starts to. That wall is what makes acceptance 2 — "a guest cannot
 * mutate status or provider payment directly" — checkable by a reviewer reading
 * a list of imports rather than by tracing every branch. The DECISION service
 * next door imports all four, and the split between the two files is the
 * boundary.
 *
 * ## Convergence, not conflict
 *
 * Acceptance 4 asks that duplicates cannot double-refund or double-restock, and
 * the first line of that defence is here: a repeated submit CONVERGES on the
 * existing request rather than answering 409. Two mechanisms do it and both are
 * needed — a partial unique on the open states (two racers, one row) and an
 * idempotency key (one client retrying after a timeout it never saw). Neither
 * covers the other: the index cannot tell a retry from a genuine second request
 * once the first is decided, and the key is absent on most calls.
 */

import type {
  CancellationRequestReason,
  SubmitCancellationRequestInput,
} from '@mercaria/shared-types';
import { BUYER_REQUEST_NOTE_MAX_LENGTH } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findCancellationRequestById,
  findCancellationRequestByIdempotencyKey,
  findOpenCancellationRequestForOrder,
  insertCancellationRequest,
  listCancellationRequestLines,
  listCancellationRequestsForOrder,
  transitionCancellationRequest,
  type CancellationRequestRow,
} from '../../db/buyerRequests/cancellationRepository.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { actorAuditColumns, type BuyerRequestActor } from './authorization.js';
import { notifyCancellationReceived } from './notifications.js';
import { cancellationEligibilityWithOpenRequest } from './policy.js';
import { orderedQuantitiesByVariant, type BuyerRequestOrderContext } from './order-facts.js';

/** A request plus its lines — what every read here returns. */
export interface CancellationRequestWithLines {
  readonly request: CancellationRequestRow;
  readonly lines: Awaited<ReturnType<typeof listCancellationRequestLines>>;
}

/** Load a request and its lines together. */
async function withLines(
  request: CancellationRequestRow,
): Promise<CancellationRequestWithLines> {
  return { request, lines: await listCancellationRequestLines(request.id) };
}

/**
 * Validate the lines a buyer named against the order's own.
 *
 * Every quantity is checked against what was ORDERED rather than against what a
 * client sent alongside it, and an unknown variant is refused rather than
 * ignored — a silently dropped line is a buyer who thinks they cancelled two
 * things and cancelled one.
 */
function assertLinesMatchOrder(
  context: BuyerRequestOrderContext,
  lines: { variantId: string; quantity: number }[],
): void {
  const ordered = orderedQuantitiesByVariant(context.order);
  const seen = new Set<string>();
  for (const line of lines) {
    const available = ordered.get(line.variantId);
    if (available === undefined) {
      throw validationError('A requested line is not part of this order');
    }
    if (seen.has(line.variantId)) {
      throw validationError('A variant may appear only once in a request');
    }
    seen.add(line.variantId);
    if (line.quantity < 1 || line.quantity > available) {
      throw validationError('A requested quantity is outside what was ordered');
    }
  }
}

/**
 * File a cancellation request.
 *
 * The `actor` is unforgeable and carries the scope check that produced it — see
 * `authorization.ts`. The ORDER is passed as a loaded context rather than an id
 * so this function cannot be called with an order nobody authorized: the caller
 * had to load it to authorize it, and handing it back is cheaper than trusting
 * that they did.
 */
export async function submitCancellationRequest(input: {
  context: BuyerRequestOrderContext;
  actor: BuyerRequestActor;
  body: SubmitCancellationRequestInput;
  idempotencyKey?: string;
  now: Date;
}): Promise<CancellationRequestWithLines> {
  const { context, actor, body } = input;

  // The retry path comes FIRST and answers before any policy is consulted: a
  // client repeating a call that already succeeded must get the same answer,
  // even if the order has since shipped and a fresh request would now be
  // refused.
  if (input.idempotencyKey !== undefined) {
    const prior = await findCancellationRequestByIdempotencyKey(input.idempotencyKey);
    if (prior) return withLines(prior);
  }

  if (body.note !== undefined && body.note.length > BUYER_REQUEST_NOTE_MAX_LENGTH) {
    throw validationError('The note is too long');
  }
  const lines = body.lines ?? [];
  if (lines.length > 0) assertLinesMatchOrder(context, lines);

  const open = await findOpenCancellationRequestForOrder(context.order.id);
  const eligibility = cancellationEligibilityWithOpenRequest(context.policy, open !== undefined);
  if (eligibility.verdict === 'ineligible') {
    // A live request is a CONVERGENCE, not a refusal: the buyer asked for the
    // same thing twice and the honest answer is the request they already have.
    if (eligibility.reason === 'request_already_open' && open) return withLines(open);
    throw conflict(`This order cannot be cancelled: ${eligibility.reason}`);
  }
  // A PARTIAL cancellation only works when money has moved: undoing part of an
  // UNPAID order would mean rewriting the order's lines and totals, which are
  // an immutable snapshot. #110 cancellation field 3 says "where supported",
  // and this is where. The remedy is stated rather than implied.
  if (lines.length > 0 && eligibility.mode === 'release') {
    throw validationError(
      'Part of an unpaid order cannot be cancelled; cancel the whole order, or wait until it ' +
        'is paid and ask for a partial refund',
    );
  }

  const created = await getDb().transaction(async (tx) => {
    const row = await insertCancellationRequest(tx, {
      orderId: context.order.id,
      reason: body.reason as CancellationRequestReason,
      ...(body.note === undefined ? {} : { note: body.note }),
      completionMode: eligibility.mode,
      wholeOrder: lines.length === 0,
      requestedByActorKind: actor.kind,
      ...(actor.oxyUserId === undefined ? {} : { requestedByOxyUserId: actor.oxyUserId }),
      ...(actor.grantId === undefined ? {} : { requestedByGrantId: actor.grantId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      lines: lines.map((line) => ({ variantId: line.variantId, requestedQuantity: line.quantity })),
    });
    if (!row) return null;
    // The audit row commits with the request, so a rolled-back submission
    // leaves no trail claiming somebody asked.
    await recordBuyerRequestEvent(tx, {
      cancellationRequestId: row.id,
      kind: 'submitted',
      ...actorAuditColumns(actor),
      at: input.now,
    });
    return row;
  });

  // `null` means another writer claimed the order between the eligibility read
  // and the insert. Reading back is the convergence — the moderation
  // dedupe-claim shape, where the empty RETURNING set IS the answer.
  if (!created) {
    const converged =
      (await findOpenCancellationRequestForOrder(context.order.id)) ??
      (input.idempotencyKey === undefined
        ? undefined
        : await findCancellationRequestByIdempotencyKey(input.idempotencyKey));
    if (converged) return withLines(converged);
    throw conflict('This order already has a cancellation request');
  }

  notifyCancellationReceived(context.order, created.id);

  const stored = await findCancellationRequestById(created.id);
  if (!stored) throw notFound('Cancellation request not found');
  return withLines(stored);
}

/**
 * Withdraw a request the buyer no longer wants.
 *
 * Only from `submitted`: once a seller has accepted, the goods or the money are
 * already moving and "never mind" is not a state the world can be returned to.
 * The compare-and-swap is what makes that race-free — a withdrawal and an
 * acceptance arriving together produce one outcome, and the loser is told.
 */
export async function withdrawCancellationRequest(input: {
  requestId: string;
  actor: BuyerRequestActor;
  now: Date;
}): Promise<CancellationRequestWithLines> {
  const existing = await findCancellationRequestById(input.requestId);
  if (!existing) throw notFound('Cancellation request not found');
  // Idempotent: withdrawing an already-withdrawn request converges rather than
  // erroring, because the client that retried cannot tell its first call from a
  // lost response.
  if (existing.state === 'withdrawn') return withLines(existing);

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionCancellationRequest(tx, {
      id: input.requestId,
      from: 'submitted',
      to: 'withdrawn',
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      cancellationRequestId: input.requestId,
      kind: 'withdrawn',
      ...actorAuditColumns(input.actor),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This request has already been decided');

  const stored = await findCancellationRequestById(input.requestId);
  if (!stored) throw notFound('Cancellation request not found');
  return withLines(stored);
}

/** Every cancellation request filed against one order, newest first. */
export async function listCancellationRequests(
  orderId: string,
): Promise<CancellationRequestWithLines[]> {
  const requests = await listCancellationRequestsForOrder(orderId);
  return Promise.all(requests.map(withLines));
}

/** One request by id, with its lines. */
export async function getCancellationRequest(
  requestId: string,
): Promise<CancellationRequestWithLines> {
  const request = await findCancellationRequestById(requestId);
  if (!request) throw notFound('Cancellation request not found');
  return withLines(request);
}
