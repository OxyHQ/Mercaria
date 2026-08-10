/**
 * The retail reconciliation operator surface (#128 "Operator surface").
 *
 * ## Read, plus a CLOSED set of three writes, each driving an existing path
 *
 * `reconcile_order` runs the sweep's own function for one order.
 * `retry_adjustment_refund` drives the same idempotent refund the sweep drives.
 * `resolve_exception` closes a recording. That is the whole surface: there is no
 * "set this variance", no "waive this adjustment", no "override this cost", no
 * "mark this reconciled" and no delete. Every one of those would be a second,
 * unreviewed way to change a financial record — reachable by whoever holds an
 * operator credential, with none of the compare-and-swaps the real paths carry.
 *
 * ## Every attempt is audited, refusals included
 *
 * `withAudit` wraps every handler, so an attempt the surface DECLINED is
 * recorded with the same weight as one it performed. A table of successes would
 * make a refused action indistinguishable from one nobody tried, which is the
 * question an incident review asks first. Actor and reason are mandatory.
 */

import type { Request, Response } from 'express';
import type { RetailReconciliationOperatorAction } from '@mercaria/shared-types';
import { recordReconciliationOperatorAction } from '../db/retailReconciliation/auditRepository.js';
import {
  findReconciliationException,
  listOpenReconciliationExceptions,
  resolveReconciliationException,
} from '../db/retailReconciliation/exceptionRepository.js';
import { listOpenAdjustments } from '../db/retailReconciliation/adjustmentRepository.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';
import { procurementOperatorId } from '../middleware/procurement-operator-authz.js';
import { settleRetailCustomerAdjustmentOnRequest } from '../services/retail-reconciliation/adjustment.service.js';
import {
  readRetailReconciliationMetrics,
  readRetailReconciliationView,
} from '../services/retail-reconciliation/projection.js';
import { reconcileRetailOrder } from '../services/retail-reconciliation/reconciliation.service.js';
import { ingestSupplierCreditsForOrder } from '../services/retail-reconciliation/supplier-credit.service.js';

/** How far back the metrics window reaches when the caller names no bound. */
const DEFAULT_METRICS_WINDOW_DAYS = 30;

/** A required path parameter, or a 400 that names it. */
function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`\`${name}\` is required.`);
  }
  return value;
}

/** A bounded integer query parameter. */
function boundedQuery(req: Request, name: string, fallback: number, max: number): number {
  const raw = req.query[name];
  const parsed = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** The mandatory reason every write carries, already validated by the schema. */
function operatorReason(req: Request): string {
  const { reason } = req.body as { reason: string };
  return reason;
}

/**
 * Run one handler and record the attempt, whatever it did.
 *
 * The audit write is NOT best-effort and is not `void`-ed: an action whose audit
 * failed must fail, because the alternative is a financial path an operator can
 * drive with no record that they did. The refusal branch is audited first and
 * then thrown, so the row exists before the client learns anything.
 */
async function withAudit<T>(
  input: {
    req: Request;
    action: RetailReconciliationOperatorAction;
    reason: string;
    orderId?: string;
    adjustmentId?: string;
    exceptionId?: string;
  },
  run: () => Promise<{ outcome: 'applied' | 'no_op'; body: T } | { outcome: 'refused'; detail: string }>,
): Promise<T> {
  const actorOxyUserId = procurementOperatorId(input.req);
  const subject = {
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.adjustmentId ? { adjustmentId: input.adjustmentId } : {}),
    ...(input.exceptionId ? { exceptionId: input.exceptionId } : {}),
  };

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error: unknown) {
    await recordReconciliationOperatorAction({
      action: input.action,
      outcome: 'refused',
      actorOxyUserId,
      reason: input.reason,
      ...subject,
      refusalDetail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (result.outcome === 'refused') {
    await recordReconciliationOperatorAction({
      action: input.action,
      outcome: 'refused',
      actorOxyUserId,
      reason: input.reason,
      ...subject,
      refusalDetail: result.detail,
    });
    throw notFound(result.detail);
  }

  await recordReconciliationOperatorAction({
    action: input.action,
    outcome: result.outcome,
    actorOxyUserId,
    reason: input.reason,
    ...subject,
  });
  return result.body;
}

/** `GET /internal/retail-reconciliation/orders/:orderId` — #128's twelve items. */
export async function retailReconciliationTraceHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const orderId = requiredParam(req, 'orderId');
  const view = await readRetailReconciliationView(orderId);
  if (!view) {
    throw notFound(
      `Order ${orderId} has no reconciliation. Either it is not a mercaria_retail order, or ` +
        'nothing has reconciled it yet — POST to this order’s reconcile endpoint to run one.',
    );
  }
  res.json({ success: true, data: view });
}

/** `POST /internal/retail-reconciliation/orders/:orderId/reconcile` */
export async function reconcileRetailOrderHandler(req: Request, res: Response): Promise<void> {
  const orderId = requiredParam(req, 'orderId');
  const reason = operatorReason(req);

  const data = await withAudit(
    { req, action: 'reconcile_order', reason, orderId },
    async () => {
      // Credits first, exactly as the sweep does, so a credit note that arrived
      // since the last pass is part of the evidence this revision reads.
      await ingestSupplierCreditsForOrder({ orderId });
      const outcome = await reconcileRetailOrder({ orderId });
      if (!outcome.reconciliation) {
        return {
          outcome: 'refused' as const,
          detail:
            `Order ${orderId} cannot be reconciled: it is not a mercaria_retail order with a ` +
            'procurement intent, or no reconciliation policy version is active.',
        };
      }
      const view = await readRetailReconciliationView(orderId);
      return {
        // A run that found the evidence unchanged wrote nothing, and saying so
        // is the point: an operator pressing twice should be told the second
        // press changed nothing rather than shown an identical success.
        outcome: outcome.created ? ('applied' as const) : ('no_op' as const),
        body: { created: outcome.created, reconciliation: view },
      };
    },
  );
  res.json({ success: true, data });
}

/** `POST /internal/retail-reconciliation/adjustments/:id/retry-refund` */
export async function retryAdjustmentRefundHandler(req: Request, res: Response): Promise<void> {
  const adjustmentId = requiredParam(req, 'id');
  const reason = operatorReason(req);

  const data = await withAudit(
    { req, action: 'retry_adjustment_refund', reason, adjustmentId },
    async () => {
      const outcome = await settleRetailCustomerAdjustmentOnRequest({ adjustmentId });
      if (!outcome) {
        return { outcome: 'refused' as const, detail: `No adjustment ${adjustmentId} exists.` };
      }
      if (outcome.blocked) {
        return {
          outcome: 'refused' as const,
          detail:
            `The rail cannot serve adjustment ${adjustmentId}: ${outcome.blocked}. The amount ` +
            'is still owed and the obligation stays open.',
        };
      }
      return {
        outcome: outcome.refundId ? ('applied' as const) : ('no_op' as const),
        body: { adjustmentId, refundId: outcome.refundId, state: outcome.adjustment.state },
      };
    },
  );
  res.json({ success: true, data });
}

/** `POST /internal/retail-reconciliation/exceptions/:id/resolve` */
export async function resolveReconciliationExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const exceptionId = requiredParam(req, 'id');
  const reason = operatorReason(req);

  const data = await withAudit(
    { req, action: 'resolve_exception', reason, exceptionId },
    async () => {
      const existing = await findReconciliationException(exceptionId);
      if (!existing) {
        return { outcome: 'refused' as const, detail: `No exception ${exceptionId} exists.` };
      }
      const resolved = await resolveReconciliationException({
        id: exceptionId,
        resolvedByOxyUserId: procurementOperatorId(req),
        reason,
      });
      // A compare-and-swap loser: somebody else closed it first, and their
      // decision stands. `no_op` rather than a refusal, because nothing was
      // wrong with the attempt.
      return {
        outcome: resolved ? ('applied' as const) : ('no_op' as const),
        body: { exceptionId, resolved: resolved !== undefined },
      };
    },
  );
  res.json({ success: true, data });
}

/** `GET /internal/retail-reconciliation/exceptions` — the open queue. */
export async function listReconciliationExceptionsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const limit = boundedQuery(req, 'limit', 50, 200);
  const kindRaw = req.query['kind'];
  const kind = typeof kindRaw === 'string' && kindRaw.trim() !== '' ? kindRaw.trim() : undefined;
  const rows = await listOpenReconciliationExceptions({
    limit,
    ...(kind ? { kind: kind as Parameters<typeof listOpenReconciliationExceptions>[0]['kind'] } : {}),
  });
  res.json({ success: true, data: rows });
}

/** `GET /internal/retail-reconciliation/adjustments` — what is still owed. */
export async function listOpenAdjustmentsHandler(req: Request, res: Response): Promise<void> {
  const limit = boundedQuery(req, 'limit', 50, 200);
  const rows = await listOpenAdjustments({ limit });
  res.json({ success: true, data: rows });
}

/** `GET /internal/retail-reconciliation/metrics` — the ten, with their definitions. */
export async function retailReconciliationMetricsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const days = boundedQuery(req, 'days', DEFAULT_METRICS_WINDOW_DAYS, 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
  const metrics = await readRetailReconciliationMetrics({ since });
  res.json({ success: true, data: { windowDays: days, metrics } });
}
