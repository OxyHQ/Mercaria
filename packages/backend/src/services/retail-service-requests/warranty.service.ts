/**
 * The durable warranty case (#127 §"Warranty and legal guarantee").
 *
 * All twelve facts the issue asks the case to be *capable of representing* have
 * a column; two of them have no writer and both are named rather than faked.
 *
 * ## Mercaria must not advertise a period it cannot support
 *
 * That is the issue's own sentence and it is the reason
 * `SUPPORTED_RETAIL_CUSTOMER_OUTCOMES` excludes `repair`, `replacement` and
 * `redelivery`: each needs a SECOND purchase order against the same order and
 * the same supplier, which #124's `po:<orderId>:<supplierId>` key makes
 * unrepresentable. So the guarantee Mercaria supports is the refund-shaped one,
 * the case records both what the buyer asked for and what Mercaria delivered,
 * and the decision path refuses an undeliverable outcome BY NAME rather than
 * accepting it and failing a week later.
 *
 * A refund is never worse for the buyer than the remedy it replaces, which is
 * what makes that a real answer rather than a placeholder — and under EU
 * conformity law a consumer who is offered neither repair nor replacement within
 * a reasonable time is entitled to exactly this.
 *
 * ## The guarantee period comes from the ORDER, not from today's constants
 *
 * #126 snapshots `warranty_months` onto `retail_order_role_snapshots` in the
 * order's own transaction, and this reads that. A buyer asking in two years what
 * their guarantee was is answered from their purchase — which is the whole
 * reason the snapshot stores numbers rather than a version pointer.
 */

import type { RetailWarrantyCaseState } from '@mercaria/shared-types';
import {
  countRetailWarrantyCasesForOrder,
  findRetailWarrantyCaseForRequest,
  insertRetailWarrantyCase,
  transitionRetailWarrantyCase,
  type RetailWarrantyCaseRow,
} from '../../db/retailServiceRequests/warrantyRepository.js';
import { appendRetailServiceEvent, findRetailServiceRequest } from '../../db/retailServiceRequests/requestRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { retailDeciderAudit, type RetailServiceDecider } from './authorization.js';
import { loadRetailServiceOrder } from './order-facts.js';
import { notifyRetailSafetyNotice, notifyRetailWarrantyUpdated } from './notifications.js';
import type { RetailTermsSnapshot } from './policy.js';

/** `months` after `from`, calendar-correct — see `policy.ts` for why. */
function addMonths(from: Date, months: number): Date {
  const out = new Date(from.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * Open one case, from an accepted request whose kind opens one.
 *
 * `repeat_failure_count` is counted from the order's EXISTING cases rather than
 * incremented on a row — the count is a fact about the goods across cases, and
 * an increment would need a lock and a re-read to be correct under two
 * concurrent reports where a count is exact in one indexed statement.
 *
 * The `path` defaults to `supplier`, which is where a dropshipped item's
 * recourse actually lies. It is a fact about RECOURSE and never about who the
 * buyer deals with: `RetailServiceRequestView` has no path member at all.
 */
export async function openRetailWarrantyCase(
  decider: RetailServiceDecider,
  input: {
    requestId: string;
    orderId: string;
    terms: RetailTermsSnapshot;
    market: string;
    reportedAt: Date;
    serialNumber?: string;
    lotNumber?: string;
  },
): Promise<RetailWarrantyCaseRow> {
  const existing = await findRetailWarrantyCaseForRequest(input.requestId);
  if (existing !== undefined) return existing;

  const priorCases = await countRetailWarrantyCasesForOrder(input.orderId);
  const row = await insertRetailWarrantyCase({
    requestId: input.requestId,
    basis: 'legal_guarantee',
    path: 'supplier',
    reportedAt: input.reportedAt,
    guaranteeMarket: input.market,
    guaranteeMonths: input.terms.warrantyMonths,
    guaranteeExpiresAt: addMonths(input.reportedAt, input.terms.warrantyMonths),
    ...(input.serialNumber === undefined ? {} : { serialNumber: input.serialNumber }),
    ...(input.lotNumber === undefined ? {} : { lotNumber: input.lotNumber }),
    instructionsKey: 'retail.warranty.instructions.v1',
    repeatFailureCount: priorCases,
  });
  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: 'warranty_case_opened',
    ...retailDeciderAudit(decider),
    detail: row.id,
  });
  return row;
}

/** Move a case, and tell the buyer. */
export async function advanceRetailWarrantyCase(
  decider: RetailServiceDecider,
  input: {
    requestId: string;
    to: RetailWarrantyCaseState;
    supplierResponse?: string;
    supplierRespondedAt?: Date;
    customerDeadlineAt?: Date;
    resolvedAt?: Date;
  },
): Promise<RetailWarrantyCaseRow> {
  const existing = await findRetailWarrantyCaseForRequest(input.requestId);
  if (existing === undefined) throw notFound('Warranty case not found');

  const moved = await transitionRetailWarrantyCase({
    id: existing.id,
    // Every state except the two terminal ones, so a case can move backwards
    // when a repair fails and forwards when it does not — a warranty is not a
    // one-way pipeline and modelling it as one is how a failed repair becomes
    // unrecordable.
    from: ['reported', 'assessing', 'awaiting_item', 'in_repair'],
    to: input.to,
    ...(input.supplierResponse === undefined
      ? {}
      : { supplierResponse: input.supplierResponse }),
    ...(input.supplierRespondedAt === undefined
      ? {}
      : { supplierRespondedAt: input.supplierRespondedAt }),
    ...(input.customerDeadlineAt === undefined
      ? {}
      : { customerDeadlineAt: input.customerDeadlineAt }),
    ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
  });
  if (!moved) throw conflict('This warranty case has already been resolved.');

  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: 'warranty_case_updated',
    ...retailDeciderAudit(decider),
    detail: input.to,
  });
  const request = await findRetailServiceRequest(input.requestId);
  if (request) {
    const context = await loadRetailServiceOrder(request.orderId);
    if (context !== null) notifyRetailWarrantyUpdated(context.order, input.requestId, input.to);
  }
  return moved;
}

/**
 * Escalate a case to product safety (#127 warranty item 12).
 *
 * The escalation is always EXPLAINED — a CHECK refuses an escalation instant
 * with no reason, because an escalation nobody can explain is the shape a recall
 * gets raised in by accident and never withdrawn. It also sends a safety notice,
 * which is the one message kind in this domain that is deduped on the REQUEST
 * alone: a notice re-sent is better than one swallowed.
 *
 * It does NOT raise a #121 suppression. Deciding that a product must come off
 * sale is a compliance power on a different allow-list
 * (`RETAIL_OPERATOR_OXY_USER_IDS`) with four-eyes behind it, and a warranty
 * operator reaching it from here would be that power granted sideways. The
 * escalation is the signal; `/internal/retail-eligibility/*` is where somebody
 * acts on it.
 */
export async function escalateRetailWarrantySafety(
  decider: RetailServiceDecider,
  input: { requestId: string; reason: string },
  now: Date,
): Promise<RetailWarrantyCaseRow> {
  const existing = await findRetailWarrantyCaseForRequest(input.requestId);
  if (existing === undefined) throw notFound('Warranty case not found');

  const moved = await transitionRetailWarrantyCase({
    id: existing.id,
    from: ['reported', 'assessing', 'awaiting_item', 'in_repair'],
    to: 'escalated_safety',
    safetyEscalatedAt: now,
    safetyEscalationReason: input.reason,
  });
  if (!moved) throw conflict('This warranty case can no longer be escalated.');

  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: 'warranty_safety_escalated',
    ...retailDeciderAudit(decider),
    detail: input.reason,
  });
  const request = await findRetailServiceRequest(input.requestId);
  if (request) {
    const context = await loadRetailServiceOrder(request.orderId);
    if (context !== null) notifyRetailSafetyNotice(context.order, input.requestId);
  }
  return moved;
}
