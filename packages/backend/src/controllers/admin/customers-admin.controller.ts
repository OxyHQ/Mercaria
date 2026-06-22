/**
 * Store customers controller (THIN) — the store-scoped buyer records admin path.
 *
 * Every customer operation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a member may only list/get/create/update customers on their own
 * store, and read a customer's order history. All business logic lives in
 * `customer.service`; responses are the `Customer` DTO (`toCustomerDTO`) or order
 * summaries (for the history route).
 */

import type { Request, Response } from 'express';
import type { CreateCustomerInput, UpdateCustomerInput } from '@mercaria/shared-types';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getCustomerOrders,
  toCustomerDTO,
} from '../../services/customer.service.js';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../../utils/pagination.js';
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

/** GET /admin/stores/:storeId/customers — the store's customers (paginated, optional search). */
export async function listStoreCustomers(req: Request, res: Response): Promise<void> {
  try {
    const { page, limit } = parsePagination(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const { data, total } = await listCustomers(storeId(req), { page, limit, search });
    sendPaginated(res, data.map(toCustomerDTO), buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store customers');
    respondWithError(res, err, 'Failed to load customers');
  }
}

/** GET /admin/stores/:storeId/customers/:id — a single customer. */
export async function getStoreCustomer(req: Request, res: Response): Promise<void> {
  try {
    const customer = await getCustomer(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, toCustomerDTO(customer));
  } catch (err) {
    log.general.error({ err, customerId: req.params.id }, 'Failed to load store customer');
    respondWithError(res, err, 'Failed to load customer');
  }
}

/** GET /admin/stores/:storeId/customers/:id/orders — a customer's order history (summaries). */
export async function getStoreCustomerOrders(req: Request, res: Response): Promise<void> {
  try {
    const orders = await getCustomerOrders(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, orders);
  } catch (err) {
    log.general.error({ err, customerId: req.params.id }, 'Failed to load customer orders');
    respondWithError(res, err, 'Failed to load customer orders');
  }
}

/** POST /admin/stores/:storeId/customers — create a customer. */
export async function createStoreCustomer(req: Request, res: Response): Promise<void> {
  try {
    const customer = await createCustomer(storeId(req), req.body as CreateCustomerInput);
    sendSuccess(res, toCustomerDTO(customer), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store customer');
    respondWithError(res, err, 'Failed to create customer');
  }
}

/** PATCH /admin/stores/:storeId/customers/:id — update a customer. */
export async function patchStoreCustomer(req: Request, res: Response): Promise<void> {
  try {
    const customer = await updateCustomer(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateCustomerInput,
    );
    sendSuccess(res, toCustomerDTO(customer));
  } catch (err) {
    log.general.error({ err, customerId: req.params.id }, 'Failed to update store customer');
    respondWithError(res, err, 'Failed to update customer');
  }
}
