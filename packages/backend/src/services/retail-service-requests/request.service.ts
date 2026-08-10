/**
 * Filing and withdrawing a retail service request — the BUYER's half (#127
 * §"Retail service-request model", responsibility rules 1 and 7).
 *
 * ## This module moves no money, changes no order and touches no stock
 *
 * It imports no order writer, no refund service, no inventory function and
 * nothing from `services/payments/` — `retail-service-isolation.test.ts` fails
 * the build if it starts to, and asserts the positive half too (the DECISION
 * service does reach them) so the gate cannot pass by those having been renamed
 * out of existence. #110 established the shape and the reasoning is identical:
 * cancelling a paid order has to return money and respect a fulfilment state,
 * and every one of those belongs to a service that already gets it right.
 *
 * ## A guest and an account holder run the same code
 *
 * #127 responsibility rule 7 — *"guest buyers receive the same supported rights
 * without creating an Oxy account"* — is not a branch here. The credential is
 * resolved by the route, `authorizeBuyerRequest` composes #106's order access,
 * and everything below takes the resulting actor. There is nothing
 * guest-shaped left to fork (ADR 0003 I9).
 */

import type {
  RetailServiceEvidenceKind,
  RetailServiceRequestKind,
} from '@mercaria/shared-types';
import {
  RETAIL_SERVICE_EVIDENCE_MAX_COUNT,
  RETAIL_SERVICE_NOTE_MAX_LENGTH,
} from '@mercaria/shared-types';
import {
  addRetailServiceEvidence,
  appendRetailServiceEvent,
  findOpenRetailServiceRequest,
  findRetailServiceRequest,
  findRetailServiceRequestByIdempotencyKey,
  insertRetailServiceRequest,
  listRetailServiceRequestsForOrder,
  readUnresolvedRetailUnits,
  transitionRetailServiceRequest,
  type RetailServiceRequestRecord,
} from '../../db/retailServiceRequests/requestRepository.js';
import { findLiveRetailPolicyException } from '../../db/retailServiceRequests/policyRepository.js';
import { getDb } from '../../db/postgres.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import type { BuyerRequestActor } from '../buyer-requests/authorization.js';
import { deriveRetailServiceEligibility, initialRequestState } from './eligibility.js';
import { loadRetailServiceOrder, type RetailServiceOrderContext } from './order-facts.js';
import { deriveRetailServiceDeadlines } from './policy.js';
import { notifyRetailRequestReceived } from './notifications.js';

/** One line a buyer names. */
export interface RetailServiceRequestLineInput {
  orderItemId: string;
  quantity: number;
}

/** One declared Oxy file. */
export interface RetailServiceEvidenceInput {
  fileId: string;
  kind: RetailServiceEvidenceKind;
  caption?: string;
}

/** What a buyer sends. */
export interface SubmitRetailRequestInput {
  orderId: string;
  kind: RetailServiceRequestKind;
  lines: RetailServiceRequestLineInput[];
  customerNote?: string;
  evidence?: RetailServiceEvidenceInput[];
  idempotencyKey?: string;
}

/**
 * How long Mercaria gives a supplier to answer before an operator is told.
 *
 * A CONSTANT and Mercaria's own, not a supplier's SLA — reading a supplier's
 * promise here would make the moment Mercaria notices a silent supplier a
 * function of what that supplier claimed. It bounds nothing on the customer
 * side: #127 policy rule 9 is that a missing supplier response does not make a
 * request disappear, and nothing keyed on this instant closes anything.
 */
export const RETAIL_SUPPLIER_RESPONSE_DAYS = 5;

/**
 * File one request.
 *
 * Converges three ways and none covers the others: the caller's idempotency key
 * (one client retrying after a timeout it never saw), the partial unique on
 * `(order_id, kind)` over the open states (two concurrent submissions), and the
 * repository's quantity cap (two DIFFERENT requests claiming one unit).
 */
export async function submitRetailServiceRequest(
  actor: BuyerRequestActor,
  input: SubmitRetailRequestInput,
  now: Date,
): Promise<RetailServiceRequestRecord> {
  if (input.idempotencyKey !== undefined) {
    const existing = await findRetailServiceRequestByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
  }

  const context = await loadRetailServiceOrder(input.orderId);
  if (context === null) throw notFound('Order not found');
  assertNoteWithinBounds(input.customerNote);
  assertEvidenceIsDeclarable(input.evidence ?? []);

  const eligibility = await evaluateRetailRequestEligibility(context, {
    kind: input.kind,
    lines: input.lines,
    hasEvidence: (input.evidence ?? []).length > 0,
    now,
  });
  if (eligibility.verdict === 'ineligible') {
    // The reason is the buyer's next action. It names no supplier, no other
    // buyer and nothing about the order's contents — every member of
    // `RETAIL_SERVICE_INELIGIBILITY_REASONS` is safe to say out loud.
    throw conflict(`This request cannot be opened: ${eligibility.reason}`);
  }

  const deadlines = deriveRetailServiceDeadlines({
    kind: input.kind,
    terms: context.terms,
    clock: context.clock,
  });

  const record = await getDb().transaction(async (tx) =>
    insertRetailServiceRequest(
      {
        orderId: input.orderId,
        kind: input.kind,
        state: initialRequestState(eligibility),
        origin: 'customer',
        requesterKind: actor.kind,
        ...(actor.oxyUserId === undefined ? {} : { requesterOxyUserId: actor.oxyUserId }),
        ...(actor.grantId === undefined ? {} : { requesterGrantId: actor.grantId }),
        ...(input.customerNote === undefined ? {} : { customerNote: input.customerNote }),
        customerTermsVersion: context.terms.customerTermsVersion,
        policyMarket: context.market,
        ...(deadlines.statutoryAt === null ? {} : { statutoryDeadlineAt: deadlines.statutoryAt }),
        ...(deadlines.commercialAt === null
          ? {}
          : { commercialDeadlineAt: deadlines.commercialAt }),
        supplierResponseDueAt: new Date(
          now.getTime() + RETAIL_SUPPLIER_RESPONSE_DAYS * 24 * 60 * 60 * 1000,
        ),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        lines: input.lines.map((line) => ({
          orderItemId: line.orderItemId,
          requestedQuantity: line.quantity,
        })),
        evidence: (input.evidence ?? []).map((item, index) => ({
          fileId: item.fileId,
          kind: item.kind,
          ...(item.caption === undefined ? {} : { caption: item.caption }),
          position: index,
        })),
      },
      tx,
    ),
  );

  await appendRetailServiceEvent({
    requestId: record.id,
    kind: 'request_submitted',
    resultingState: record.state,
    actorKind: actor.kind,
    ...(actor.oxyUserId === undefined ? {} : { actorOxyUserId: actor.oxyUserId }),
    ...(actor.grantId === undefined ? {} : { actorGrantId: actor.grantId }),
  });

  // AFTER the write succeeded, and it returns `void` — a notification failure
  // cannot roll back a request a buyer is waiting on.
  notifyRetailRequestReceived(context.order, record.id);
  log.general.info(
    { orderId: input.orderId, kind: input.kind, requestId: record.id, state: record.state },
    '[RetailService] request filed',
  );
  return record;
}

/**
 * Attach evidence to a request that is waiting for it.
 *
 * A request in `evidence_required` moves to `submitted` once anything arrives —
 * Mercaria decides whether what arrived is enough, and leaving the buyer in a
 * state that says "we need something from you" after they sent it is how a
 * support queue fills with people asking whether their photograph arrived.
 */
export async function attachRetailServiceEvidence(
  actor: BuyerRequestActor,
  input: { requestId: string; evidence: RetailServiceEvidenceInput[] },
): Promise<RetailServiceRequestRecord> {
  assertEvidenceIsDeclarable(input.evidence);
  const record = await findRetailServiceRequest(input.requestId);
  if (!record) throw notFound('Request not found');
  if (record.state !== 'evidence_required' && record.state !== 'submitted') {
    throw conflict('This request is no longer accepting evidence.');
  }

  await addRetailServiceEvidence(
    record.id,
    input.evidence.map((item, index) => ({
      fileId: item.fileId,
      kind: item.kind,
      ...(item.caption === undefined ? {} : { caption: item.caption }),
      position: record.evidence.length + index,
    })),
  );
  if (record.state === 'evidence_required') {
    await transitionRetailServiceRequest({
      id: record.id,
      from: ['evidence_required'],
      to: 'submitted',
    });
  }
  await appendRetailServiceEvent({
    requestId: record.id,
    kind: 'evidence_attached',
    resultingState: 'submitted',
    actorKind: actor.kind,
    ...(actor.oxyUserId === undefined ? {} : { actorOxyUserId: actor.oxyUserId }),
    ...(actor.grantId === undefined ? {} : { actorGrantId: actor.grantId }),
  });
  const updated = await findRetailServiceRequest(record.id);
  if (!updated) throw notFound('Request not found');
  return updated;
}

/**
 * A buyer changing their mind about their own request.
 *
 * Reachable only while nothing has been decided. Once Mercaria has accepted, the
 * remedy is running — stock may be in the post and a refund may be committed —
 * and undoing it is `cancelled`, which only an operator may write. Two facts
 * about who acted should not share a word (#110's `withdrawn`/`cancelled` pair).
 */
export async function withdrawRetailServiceRequest(
  actor: BuyerRequestActor,
  requestId: string,
  now: Date,
): Promise<RetailServiceRequestRecord> {
  const record = await findRetailServiceRequest(requestId);
  if (!record) throw notFound('Request not found');

  const moved = await transitionRetailServiceRequest({
    id: requestId,
    from: ['submitted', 'evidence_required'],
    to: 'withdrawn',
    completedAt: now,
  });
  if (!moved) throw conflict('This request has already been decided and cannot be withdrawn.');

  await appendRetailServiceEvent({
    requestId,
    kind: 'request_withdrawn',
    resultingState: 'withdrawn',
    actorKind: actor.kind,
    ...(actor.oxyUserId === undefined ? {} : { actorOxyUserId: actor.oxyUserId }),
    ...(actor.grantId === undefined ? {} : { actorGrantId: actor.grantId }),
  });
  const updated = await findRetailServiceRequest(requestId);
  if (!updated) throw notFound('Request not found');
  return updated;
}

/** Every request on one order. */
export async function listRetailServiceRequests(
  orderId: string,
): Promise<RetailServiceRequestRecord[]> {
  return listRetailServiceRequestsForOrder(orderId);
}

/**
 * The eligibility derivation with its live inputs gathered.
 *
 * Exported because the STOREFRONT needs the same answer to decide which buttons
 * exist, and two spellings of "is this returnable" would eventually disagree —
 * with the visible failure being a button that exists and then 409s. The submit
 * path re-runs it rather than trusting a client that read it, so this is a
 * projection and never an authorization.
 */
export async function evaluateRetailRequestEligibility(
  context: RetailServiceOrderContext,
  input: {
    kind: RetailServiceRequestKind;
    lines: readonly RetailServiceRequestLineInput[];
    hasEvidence: boolean;
    now: Date;
  },
) {
  const [openRequest, unresolved, exception] = await Promise.all([
    findOpenRetailServiceRequest(context.order.id, input.kind),
    readUnresolvedRetailUnits(input.lines.map((line) => line.orderItemId)),
    findLiveRetailPolicyException({
      market: context.market,
      categoryIds: retailCategoryIdsOf(context),
      kind: input.kind,
    }),
  ]);

  const unresolvedUnitsAvailable =
    input.lines.length === 0
      ? false
      : input.lines.every((line) => (unresolved.get(line.orderItemId) ?? 0) >= line.quantity);

  return deriveRetailServiceEligibility({
    kind: input.kind,
    commercialRole: context.order.commercialRole,
    paymentStatus: context.order.paymentStatus,
    dispatched: context.dispatched,
    delivered: context.delivered,
    deadlines: deriveRetailServiceDeadlines({
      kind: input.kind,
      terms: context.terms,
      clock: context.clock,
    }),
    openRequestOfKind: openRequest !== undefined,
    unresolvedUnitsAvailable,
    categoryExcluded: exception !== undefined,
    hasEvidence: input.hasEvidence,
    now: input.now,
  });
}

/**
 * The categories a category exception could name for this order.
 *
 * An order line records the LISTING it was bought from and not its category, and
 * a category exception is about goods rather than about a listing. Resolving the
 * ancestry needs the catalogue, which this domain deliberately does not import —
 * so today the set is empty and no exception matches.
 *
 * **This is a NAMED gap and it fails OPEN**, unlike everything else in this
 * domain, and the direction is deliberate: an exception REMOVES a consumer
 * right, so failing closed here would refuse buyers a remedy on the strength of
 * a lookup nobody has built. The publication surface, the four-eyes review, the
 * immutability and the disjoint source vocabulary are all real and tested; what
 * is missing is the join, and it belongs with whoever gives `order_items` a
 * category snapshot.
 */
function retailCategoryIdsOf(context: RetailServiceOrderContext): readonly string[] {
  void context;
  return [];
}

/** A note within bounds, or a 400 that names the field. */
function assertNoteWithinBounds(note: string | undefined): void {
  if (note === undefined) return;
  if (note.trim().length === 0 || note.length > RETAIL_SERVICE_NOTE_MAX_LENGTH) {
    throw validationError(
      `A note must be between 1 and ${RETAIL_SERVICE_NOTE_MAX_LENGTH} characters.`,
    );
  }
}

/**
 * Evidence is DECLARED, and Mercaria validates nothing about the file itself.
 *
 * A bare Oxy `file_id`, never a URL and never a `mercaria.co` one — the
 * `abuse_reports` posture, because a reviewer's browser fetching a Mercaria URL
 * would tell this host when its content is being looked at.
 *
 * **The gap, stated:** Mercaria holds no Oxy service credential, so it cannot
 * read the file's metadata, compute a digest or scan it. Asserting any of the
 * three would be worse than admitting it has none — the same gap
 * `services/moderation/` and #110 both document, and closing it closes all three.
 */
function assertEvidenceIsDeclarable(evidence: readonly RetailServiceEvidenceInput[]): void {
  if (evidence.length > RETAIL_SERVICE_EVIDENCE_MAX_COUNT) {
    throw validationError(
      `At most ${RETAIL_SERVICE_EVIDENCE_MAX_COUNT} pieces of evidence may be attached.`,
    );
  }
  for (const item of evidence) {
    if (item.fileId.trim().length === 0) {
      throw validationError('Evidence must name a file.');
    }
    if (/^https?:\/\//i.test(item.fileId) || /mercaria/i.test(item.fileId)) {
      throw validationError('Evidence is declared as an Oxy file id, never as a URL.');
    }
  }
}
