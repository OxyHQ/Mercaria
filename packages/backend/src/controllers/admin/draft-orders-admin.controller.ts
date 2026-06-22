/**
 * Store draft orders controller (THIN) — the POS cart admin path.
 *
 * Every operation is scoped to the loaded store (`req.store`, set by `loadStore`):
 * a member may only operate on their own store's drafts. `complete` passes
 * `req.userId` as the POS operator (`actorOxyUserId`). All business logic — line
 * mutation, re-pricing, reserve+convert — lives in `draft-order.service`. List
 * responses paginate (`sendPaginated`); single responses are the `DraftOrder` DTO
 * (`toDraftOrderDTO`); `complete` returns the converted `Order` DTO.
 */

import type { Request, Response } from 'express';
import type {
  CreateDraftOrderInput,
  AddDraftLineInput,
  UpdateDraftLineInput,
  ApplyDraftDiscountsInput,
  SetDraftCustomerInput,
  UpdateDraftOrderInput,
  CompleteDraftOrderInput,
  DraftOrderStatus,
} from '@mercaria/shared-types';
import {
  createDraftOrder,
  listDraftOrders,
  getDraftOrder,
  addLine,
  updateLine,
  removeLine,
  applyDiscountCodes,
  setCustomer,
  updateDraftOrder,
  cancelDraftOrder,
  completeDraftOrder,
  toDraftOrderDTO,
} from '../../services/draft-order.service.js';
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

/** GET /admin/stores/:storeId/draft-orders — the store's drafts (paginated, optional status). */
export async function listStoreDraftOrders(req: Request, res: Response): Promise<void> {
  try {
    const { page, limit } = parsePagination(req.query);
    const status =
      typeof req.query.status === 'string' ? (req.query.status as DraftOrderStatus) : undefined;
    const { data, total } = await listDraftOrders(storeId(req), { page, limit, status });
    sendPaginated(res, data.map(toDraftOrderDTO), buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store draft orders');
    respondWithError(res, err, 'Failed to load draft orders');
  }
}

/** POST /admin/stores/:storeId/draft-orders — open a new draft. */
export async function createStoreDraftOrder(req: Request, res: Response): Promise<void> {
  try {
    const draft = await createDraftOrder(
      storeId(req),
      req.userId ?? '',
      req.body as CreateDraftOrderInput,
    );
    sendSuccess(res, toDraftOrderDTO(draft), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store draft order');
    respondWithError(res, err, 'Failed to create draft order');
  }
}

/** GET /admin/stores/:storeId/draft-orders/:id — a single draft. */
export async function getStoreDraftOrder(req: Request, res: Response): Promise<void> {
  try {
    const draft = await getDraftOrder(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to load store draft order');
    respondWithError(res, err, 'Failed to load draft order');
  }
}

/** PATCH /admin/stores/:storeId/draft-orders/:id — update note / shipping address. */
export async function patchStoreDraftOrder(req: Request, res: Response): Promise<void> {
  try {
    const draft = await updateDraftOrder(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateDraftOrderInput,
    );
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to update store draft order');
    respondWithError(res, err, 'Failed to update draft order');
  }
}

/** POST /admin/stores/:storeId/draft-orders/:id/lines — add a line. */
export async function addStoreDraftLine(req: Request, res: Response): Promise<void> {
  try {
    const draft = await addLine(storeId(req), routeParam(req, 'id'), req.body as AddDraftLineInput);
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to add draft order line');
    respondWithError(res, err, 'Failed to add line');
  }
}

/** PATCH /admin/stores/:storeId/draft-orders/:id/lines/:variantId — set a line's quantity. */
export async function updateStoreDraftLine(req: Request, res: Response): Promise<void> {
  try {
    const draft = await updateLine(
      storeId(req),
      routeParam(req, 'id'),
      routeParam(req, 'variantId'),
      req.body as UpdateDraftLineInput,
    );
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to update draft order line');
    respondWithError(res, err, 'Failed to update line');
  }
}

/** DELETE /admin/stores/:storeId/draft-orders/:id/lines/:variantId — remove a line. */
export async function removeStoreDraftLine(req: Request, res: Response): Promise<void> {
  try {
    const draft = await removeLine(storeId(req), routeParam(req, 'id'), routeParam(req, 'variantId'));
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to remove draft order line');
    respondWithError(res, err, 'Failed to remove line');
  }
}

/** POST /admin/stores/:storeId/draft-orders/:id/discounts — apply discount codes. */
export async function applyStoreDraftDiscounts(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ApplyDraftDiscountsInput;
    const draft = await applyDiscountCodes(storeId(req), routeParam(req, 'id'), body.codes);
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to apply draft order discounts');
    respondWithError(res, err, 'Failed to apply discounts');
  }
}

/** POST /admin/stores/:storeId/draft-orders/:id/customer — attach a customer. */
export async function setStoreDraftCustomer(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as SetDraftCustomerInput;
    const draft = await setCustomer(storeId(req), routeParam(req, 'id'), body.customerId);
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to set draft order customer');
    respondWithError(res, err, 'Failed to set customer');
  }
}

/** DELETE /admin/stores/:storeId/draft-orders/:id — cancel an open draft. */
export async function cancelStoreDraftOrder(req: Request, res: Response): Promise<void> {
  try {
    const draft = await cancelDraftOrder(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, toDraftOrderDTO(draft));
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to cancel store draft order');
    respondWithError(res, err, 'Failed to cancel draft order');
  }
}

/** POST /admin/stores/:storeId/draft-orders/:id/complete — take the POS sale. */
export async function completeStoreDraftOrder(req: Request, res: Response): Promise<void> {
  try {
    const order = await completeDraftOrder(
      storeId(req),
      routeParam(req, 'id'),
      req.body as CompleteDraftOrderInput,
      req.userId ?? '',
    );
    sendSuccess(res, order);
  } catch (err) {
    log.general.error({ err, draftId: req.params.id }, 'Failed to complete store draft order');
    respondWithError(res, err, 'Failed to complete draft order');
  }
}
