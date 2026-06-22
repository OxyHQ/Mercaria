/**
 * Buyer orders controller (THIN) — the caller's own orders.
 *
 * Logic lives in `order.service`. `GET /orders` lists the buyer's orders
 * (summaries, paginated); `GET /orders/:id` returns a hydrated order; the
 * `cancel` and `mock-pay` actions drive lifecycle transitions.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import {
  getBuyerOrders,
  getOrderForBuyer,
  cancelByBuyer,
  mockPay,
} from '../services/order.service.js';
import { log } from '../lib/logger.js';

/** GET /orders — the caller's orders (summaries, paginated, newest first). */
export async function listMyOrders(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const { data, total } = await getBuyerOrders(oxyUserId, { page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list buyer orders');
    respondWithError(res, err, 'Failed to load your orders');
  }
}

/** GET /orders/:id — a single hydrated order owned by the caller. */
export async function getMyOrder(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const order = await getOrderForBuyer(oxyUserId, id);
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, orderId: id }, 'Failed to load buyer order');
    respondWithError(res, err, 'Failed to load order');
  }
}

/** POST /orders/:id/cancel — cancel the caller's own order. */
export async function cancelMyOrder(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const order = await cancelByBuyer(oxyUserId, id);
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, orderId: id }, 'Failed to cancel buyer order');
    respondWithError(res, err, 'Failed to cancel order');
  }
}

/** POST /orders/:id/mock-pay — test-only: mark the caller's order paid. */
export async function mockPayMyOrder(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const order = await mockPay(oxyUserId, id);
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, orderId: id }, 'Failed to mock-pay buyer order');
    respondWithError(res, err, 'Failed to pay order');
  }
}
