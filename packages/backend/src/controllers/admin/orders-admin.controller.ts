/**
 * Store orders controller (THIN) — the store-owned order management path.
 *
 * Every action is scoped to the loaded store (`req.store`, set by `loadStore`):
 * an order is only operable here if its `storeId` matches. `GET /` lists the
 * store's orders (summaries, paginated, optional status filter); `GET /:id`
 * returns a hydrated order; `PATCH /:id/status` drives a lifecycle transition;
 * `GET /stats` returns the order dashboard stats. Logic lives in `order.service`.
 */

import type { Request, Response } from 'express';
import type { OrderStatus } from '@mercaria/shared-types';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../../utils/pagination.js';
import { routeParam } from '../../utils/request.js';
import {
  getStoreOrders,
  getOrderForStore,
  patchStoreOrderStatus,
  storeStats,
} from '../../services/order.service.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return String((store as { _id: unknown })._id);
}

/** GET /admin/stores/:storeId/orders — the store's orders (summaries, paginated). */
export async function listStoreOrders(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const { page, limit } = parsePagination(req.query);
    const status = typeof req.query.status === 'string' ? (req.query.status as OrderStatus) : undefined;
    const { data, total } = await getStoreOrders(id, { status, page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store orders');
    respondWithError(res, err, 'Failed to load orders');
  }
}

/** GET /admin/stores/:storeId/orders/:id — a single hydrated store order. */
export async function getStoreOrder(req: Request, res: Response): Promise<void> {
  const orderId = routeParam(req, 'id');
  try {
    const order = await getOrderForStore(storeId(req), orderId);
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, orderId }, 'Failed to load store order');
    respondWithError(res, err, 'Failed to load order');
  }
}

/** PATCH /admin/stores/:storeId/orders/:id/status — drive a lifecycle transition. */
export async function patchStoreOrderStatusHandler(req: Request, res: Response): Promise<void> {
  const orderId = routeParam(req, 'id');
  try {
    const body = req.body as { status: OrderStatus; trackingNumber?: string; note?: string };
    const order = await patchStoreOrderStatus(storeId(req), orderId, body, req.userId ?? '');
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, orderId }, 'Failed to patch store order status');
    respondWithError(res, err, 'Failed to update order');
  }
}

/** GET /admin/stores/:storeId/orders/stats — the store order dashboard stats. */
export async function getStoreStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = await storeStats(storeId(req));
    sendSuccess(res, stats);
  } catch (err) {
    log.general.error({ err }, 'Failed to load store stats');
    respondWithError(res, err, 'Failed to load stats');
  }
}
