/**
 * Seller orders controller (THIN) — the P2P seller's incoming orders.
 *
 * Logic lives in `order.service`. `GET /seller/orders` lists the orders whose
 * `sellerOxyUserId` is the caller (summaries, paginated, optional status
 * filter); `PATCH /seller/orders/:id/fulfill` advances an order along the
 * fulfilment path (processing → shipped → delivered).
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { getSellerOrders, fulfillSellerOrder } from '../services/order.service.js';
import type { OrderStatus } from '@mercaria/shared-types';
import { log } from '../lib/logger.js';

/** GET /seller/orders — the caller's incoming orders (summaries, paginated). */
export async function listSellerOrders(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const status = typeof req.query.status === 'string' ? (req.query.status as OrderStatus) : undefined;
    const { data, total } = await getSellerOrders(oxyUserId, { status, page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list seller orders');
    respondWithError(res, err, 'Failed to load your orders');
  }
}

/** PATCH /seller/orders/:id/fulfill — advance the caller's order along fulfilment. */
export async function fulfillOrderHandler(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as { status: 'processing' | 'shipped' | 'delivered'; trackingNumber?: string };
    const dto = await fulfillSellerOrder(oxyUserId, id, body);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, orderId: id }, 'Failed to fulfill seller order');
    respondWithError(res, err, 'Failed to update order');
  }
}
