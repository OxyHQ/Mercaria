/**
 * Store refunds controller (THIN) — process + read refunds/returns (B6).
 *
 * Every operation is scoped to the loaded store (`req.store`, set by `loadStore`):
 * a member may only refund/read their own store's orders. `createOrderRefund`
 * passes `req.userId` as the actor (`actorOxyUserId`). All business logic —
 * over-refund caps, discounted-net amounts, per-line restock, order-status flip,
 * customer-stat decrement — lives in `refund.service`. Single responses are the
 * `Refund` DTO; a created refund returns 201.
 */

import type { Request, Response } from 'express';
import type { CreateRefundInput } from '@mercaria/shared-types';
import {
  process as processRefund,
  listForOrder,
  getById,
} from '../../services/refund.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return String((store as { _id: unknown })._id);
}

/** POST /admin/stores/:storeId/orders/:id/refunds — process a refund/return. */
export async function createOrderRefund(req: Request, res: Response): Promise<void> {
  try {
    const refund = await processRefund(
      storeId(req),
      routeParam(req, 'id'),
      req.body as CreateRefundInput,
      req.userId ?? '',
    );
    sendSuccess(res, refund, 201);
  } catch (err) {
    log.general.error({ err, orderId: req.params.id }, 'Failed to process order refund');
    respondWithError(res, err, 'Failed to process refund');
  }
}

/** GET /admin/stores/:storeId/orders/:id/refunds — list an order's refunds. */
export async function listOrderRefunds(req: Request, res: Response): Promise<void> {
  try {
    const refunds = await listForOrder(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, refunds);
  } catch (err) {
    log.general.error({ err, orderId: req.params.id }, 'Failed to list order refunds');
    respondWithError(res, err, 'Failed to load refunds');
  }
}

/** GET /admin/stores/:storeId/refunds/:id — a single refund. */
export async function getStoreRefund(req: Request, res: Response): Promise<void> {
  try {
    const refund = await getById(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, refund);
  } catch (err) {
    log.general.error({ err, refundId: req.params.id }, 'Failed to load store refund');
    respondWithError(res, err, 'Failed to load refund');
  }
}
