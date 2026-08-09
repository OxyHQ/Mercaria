/**
 * Raising a procurement condition, and the ONE place that decides what raising
 * one DOES beside recording it.
 *
 * `services/payments/reconciliation`'s posture: this module detects and never
 * repairs. What it adds on top of the repository is the consequence that must
 * not be forgotten at a call site — a HALTING kind also flags the purchase
 * order for operator intervention, so `purchase_orders.operator_intervention_required`
 * and an open case can never disagree about whether somebody has to look.
 *
 * The halting set is `PROCUREMENT_HALTING_EXCEPTION_KINDS` (shared-types), read
 * rather than repeated, so widening it takes effect everywhere at once. Its
 * members are the four where continuing is actively harmful: a duplicate
 * supplier order (Mercaria is billed twice for goods ordered once), a
 * substitution (a supplier shipped something the customer did not choose — ADR
 * 0004 D9.5 makes that a non-conforming fulfilment, never a success), a late
 * acceptance after cancellation and a shipment after cancellation.
 */

import type { ProcurementExceptionKind } from '@mercaria/shared-types';
import { PROCUREMENT_HALTING_EXCEPTION_KINDS } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  setPurchaseOrderOperatorIntervention,
  type PurchaseOrderRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  raiseProcurementException,
  type ProcurementExceptionRow,
} from '../../db/supplierOrders/exceptionRepository.js';
import { redactSupplierOrderMessage } from './redact.js';
import {
  enqueueProcurementEvent,
  purchaseOrderExceptionEventId,
} from './procurement-outbox.service.js';

/** What raising one condition about a purchase order needs. */
export interface RaiseForPurchaseOrderInput {
  kind: ProcurementExceptionKind;
  purchaseOrder: Pick<PurchaseOrderRecord, 'id' | 'supplierId' | 'supplierAccountId'>;
  /** Redacted here, not by the caller — one place, so no call site can forget. */
  detail: string;
  /** Force the operator flag for a kind that is not inherently halting. */
  flagOperator?: boolean;
  providerEventId?: string;
}

/**
 * Raise a condition about one purchase order.
 *
 * Idempotent: two detections of the same condition converge on the case that is
 * already open, and the second call answers with it rather than opening a
 * duplicate. The operator flag and the announcement are applied on EVERY call
 * rather than only on the first, because a case that was opened while the flag
 * write failed must still end up flagged.
 */
export async function raiseProcurementExceptionFor(
  input: RaiseForPurchaseOrderInput,
): Promise<ProcurementExceptionRow> {
  const detail = redactSupplierOrderMessage(input.detail);
  const { exception, raised } = await raiseProcurementException({
    kind: input.kind,
    purchaseOrderId: input.purchaseOrder.id,
    supplierId: input.purchaseOrder.supplierId,
    supplierAccountId: input.purchaseOrder.supplierAccountId,
    ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    detail,
  });

  const halting = PROCUREMENT_HALTING_EXCEPTION_KINDS.includes(input.kind);
  if (halting || input.flagOperator) {
    await setPurchaseOrderOperatorIntervention({
      purchaseOrderId: input.purchaseOrder.id,
      required: true,
      note: detail,
    });
  }

  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderExceptionEventId(input.kind, input.purchaseOrder.id),
    eventType: 'purchase_order_exception',
    payload: { purchaseOrderId: input.purchaseOrder.id, kind: input.kind, exceptionId: exception.id },
  });

  const context = {
    purchaseOrderId: input.purchaseOrder.id,
    kind: input.kind,
    exceptionId: exception.id,
    raised,
  };
  // A halting condition means goods or money are already moving wrongly and
  // nothing will fix it without a person, so it must not be discoverable only
  // in a warn-level line.
  if (halting) {
    log.general.error(
      context,
      '[Procurement] HALTING exception raised — fulfilment stops until an operator closes it',
    );
  } else {
    log.general.warn(context, '[Procurement] exception raised');
  }
  return exception;
}

/** What raising one account-scoped condition needs. */
export interface RaiseForAccountInput {
  kind: ProcurementExceptionKind;
  supplierAccountId: string;
  supplierId?: string;
  detail: string;
}

/**
 * Raise a condition about a supplier ACCOUNT rather than one order.
 *
 * A rejected credential, an exhausted quota and a lagging event stream are
 * facts about the integration, not about any one purchase order — and opening
 * one case per affected order would fill the queue with copies of a single
 * problem while hiding how many orders it touches. The account-scoped partial
 * unique index is what makes that one case.
 */
export async function raiseProcurementAccountException(
  input: RaiseForAccountInput,
): Promise<ProcurementExceptionRow> {
  const detail = redactSupplierOrderMessage(input.detail);
  const { exception, raised } = await raiseProcurementException({
    kind: input.kind,
    supplierAccountId: input.supplierAccountId,
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    detail,
  });
  log.general.warn(
    { supplierAccountId: input.supplierAccountId, kind: input.kind, exceptionId: exception.id, raised },
    '[Procurement] account exception raised',
  );
  return exception;
}
