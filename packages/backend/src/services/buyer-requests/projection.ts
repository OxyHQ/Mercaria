/**
 * What each side is shown (#110 merchant experience, DTO privacy).
 *
 * Every projection NAMES its fields — the `provider_accounts` status-projection
 * rule — rather than spreading a row, so a column added to the schema cannot
 * ride out to a client because a serializer happened to use `...`. The two
 * merchant projections additionally have their key sets walked at RUNTIME
 * against `MERCHANT_BUYER_REQUEST_FIELDS` by
 * `buyer-request-merchant-projection.test.ts`, which is the half a type cannot
 * do: a field forwarded through an `any`-shaped boundary would still appear.
 *
 * ## The merchant sees `Buyer`, and nothing finer
 *
 * Not `Guest`, not `Guest #4821`, not an Oxy handle, not a masked email. #106
 * establishes that any per-buyer label is a correlation key wearing a display
 * name; #110 merchant rule 7 adds the second reason — a merchant must not be
 * able to treat a guest's request differently from an account holder's, and the
 * simplest way to guarantee that is for the request not to say which it is.
 * The buyer-origin discriminant is absent from both merchant shapes, which is
 * why they are separate TYPES rather than the buyer's view with a field added.
 */

import { SUPPORT_REDACTION_KINDS, type SupportRedactionKind } from '@mercaria/shared-types';
import type {
  BuyerRequestLine,
  CancellationRequestView,
  MerchantCancellationRequestView,
  MerchantReturnRequestView,
  ReturnEvidenceRef,
  ReturnRequestView,
  SupportMessageView,
  SupportThreadView,
} from '@mercaria/shared-types';
import type {
  CancellationRequestLineRow,
  CancellationRequestRow,
} from '../../db/buyerRequests/cancellationRepository.js';
import type {
  ReturnEvidenceRow,
  ReturnRequestLineRow,
  ReturnRequestRow,
} from '../../db/buyerRequests/returnRepository.js';
import type {
  SupportMessageRow,
  SupportThreadRow,
} from '../../db/buyerRequests/supportRepository.js';

/** The one label a merchant ever sees for a requester. See the module docblock. */
export const MERCHANT_REQUESTER_LABEL = 'Buyer';

/** The thread-local labels. Stable, and none of them names a person. */
const AUTHOR_LABELS = {
  buyer: 'Buyer',
  seller: 'Seller',
  operator: 'Mercaria',
} as const;

/** A stored redaction kind, narrowed at runtime rather than asserted. */
function isRedactionKind(value: string): value is SupportRedactionKind {
  return (SUPPORT_REDACTION_KINDS as readonly string[]).includes(value);
}

/** One request line, for either side. Both quantities, so a narrowing is visible. */
function toLine(line: CancellationRequestLineRow | ReturnRequestLineRow): BuyerRequestLine {
  return {
    variantId: line.variantId,
    requestedQuantity: line.requestedQuantity,
    approvedQuantity: line.approvedQuantity,
  };
}

/** One declared evidence reference. A bare Oxy file id — never a URL. */
function toEvidence(row: ReturnEvidenceRow): ReturnEvidenceRef {
  return { fileId: row.fileId, kind: row.kind, position: row.position };
}

/** What a BUYER sees of their own cancellation request. */
export function toCancellationRequestView(
  request: CancellationRequestRow,
  lines: CancellationRequestLineRow[],
): CancellationRequestView {
  return {
    id: request.id,
    orderId: request.orderId,
    state: request.state,
    reason: request.reason,
    ...(request.note === null ? {} : { note: request.note }),
    lines: lines.map(toLine),
    completionMode: request.completionMode,
    ...(request.decisionNote === null ? {} : { decisionNote: request.decisionNote }),
    ...(request.completionFailure === null
      ? {}
      : { completionFailure: request.completionFailure }),
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
  };
}

/** What a MERCHANT sees of a cancellation request. */
export function toMerchantCancellationRequestView(
  request: CancellationRequestRow,
  lines: CancellationRequestLineRow[],
): MerchantCancellationRequestView {
  return {
    id: request.id,
    orderId: request.orderId,
    state: request.state,
    reason: request.reason,
    ...(request.note === null ? {} : { note: request.note }),
    lines: lines.map(toLine),
    completionMode: request.completionMode,
    ...(request.decisionNote === null ? {} : { decisionNote: request.decisionNote }),
    ...(request.completionFailure === null
      ? {}
      : { completionFailure: request.completionFailure }),
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
    requesterLabel: MERCHANT_REQUESTER_LABEL,
  };
}

/** What a BUYER sees of their own return request. */
export function toReturnRequestView(
  request: ReturnRequestRow,
  lines: ReturnRequestLineRow[],
  evidence: ReturnEvidenceRow[],
): ReturnRequestView {
  return {
    id: request.id,
    orderId: request.orderId,
    state: request.state,
    reason: request.reason,
    resolution: request.resolution,
    ...(request.note === null ? {} : { note: request.note }),
    lines: lines.map(toLine),
    evidence: evidence.map(toEvidence),
    ...(request.returnInstructions === null
      ? {}
      : { returnInstructions: request.returnInstructions }),
    ...(request.decisionNote === null ? {} : { decisionNote: request.decisionNote }),
    ...(request.completionFailure === null
      ? {}
      : { completionFailure: request.completionFailure }),
    returnWindowEndsAt: request.returnWindowEndsAt.toISOString(),
    shipBackDeadlineAt: request.shipBackDeadlineAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
  };
}

/** What a MERCHANT sees of a return request. */
export function toMerchantReturnRequestView(
  request: ReturnRequestRow,
  lines: ReturnRequestLineRow[],
  evidence: ReturnEvidenceRow[],
): MerchantReturnRequestView {
  return {
    id: request.id,
    orderId: request.orderId,
    state: request.state,
    reason: request.reason,
    resolution: request.resolution,
    ...(request.note === null ? {} : { note: request.note }),
    lines: lines.map(toLine),
    // A seller DOES see the evidence: it is what they are deciding on, and the
    // buyer uploaded it for that purpose. It is still a bare file id, so the
    // seller's client fetches it from Oxy with its own credential and this host
    // never learns when it was looked at.
    evidence: evidence.map(toEvidence),
    ...(request.returnInstructions === null
      ? {}
      : { returnInstructions: request.returnInstructions }),
    ...(request.decisionNote === null ? {} : { decisionNote: request.decisionNote }),
    ...(request.completionFailure === null
      ? {}
      : { completionFailure: request.completionFailure }),
    returnWindowEndsAt: request.returnWindowEndsAt.toISOString(),
    shipBackDeadlineAt: request.shipBackDeadlineAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    completedAt: request.completedAt?.toISOString() ?? null,
    requesterLabel: MERCHANT_REQUESTER_LABEL,
  };
}

/**
 * One support message, for EITHER side.
 *
 * There is deliberately no merchant variant. The row carries no identity to
 * begin with — `author_oxy_user_id` and `author_grant_id` are protected, so the
 * repository's row type has no such property — and the label is a role rather
 * than a person, so the same projection is correct for the buyer, the seller
 * and an operator. Two projections here would be two chances to add a name to
 * one of them.
 */
export function toSupportMessageView(message: SupportMessageRow): SupportMessageView {
  return {
    id: message.id,
    authorKind: message.authorKind,
    authorLabel: AUTHOR_LABELS[message.authorKind],
    body: message.body,
    // The column is `text[]` with a containment CHECK, so drizzle types it as
    // `string[]` while Postgres already guarantees the membership. Narrowing
    // with a real runtime test rather than asserting it keeps the DTO's type
    // honest — and a value the CHECK somehow admitted is dropped rather than
    // shipped as a kind no client knows.
    redactions: message.redactions.filter(isRedactionKind),
    createdAt: message.createdAt.toISOString(),
  };
}

/** One thread and its messages. */
export function toSupportThreadView(
  thread: SupportThreadRow,
  messages: SupportMessageRow[],
): SupportThreadView {
  return {
    id: thread.id,
    orderId: thread.orderId,
    returnRequestId: thread.returnRequestId,
    state: thread.state,
    messages: messages.map(toSupportMessageView),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}
