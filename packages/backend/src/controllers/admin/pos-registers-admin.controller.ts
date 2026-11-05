/**
 * Named POS registers controller (THIN) — `/admin/stores/:storeId/pos-registers`,
 * the paid `expanded_pos_registers` tool (#89). Everything is scoped to the
 * loaded store; the allowance, the archive-or-delete rule and the summary live
 * in `pos-registers.service`.
 */

import type { Request, Response } from 'express';
import type { CreatePosRegisterInput, UpdatePosRegisterInput } from '@mercaria/shared-types';
import {
  createPosRegister,
  getPosRegisterSalesSummary,
  listPosRegisters,
  removePosRegister,
  renamePosRegister,
} from '../../services/pos-registers.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

function storeId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

function queryString(req: Request, key: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** GET — the store's registers and whether sales are attributed to them now. */
export async function listPosRegistersHandler(req: Request, res: Response): Promise<void> {
  try {
    const locationId = queryString(req, 'locationId');
    const includeArchived = (req.query as Record<string, unknown>).includeArchived === true;
    sendSuccess(
      res,
      await listPosRegisters(storeId(req), {
        ...(locationId ? { locationId } : {}),
        includeArchived,
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list POS registers');
    respondWithError(res, err, 'Failed to list registers');
  }
}

/** POST — add a named register (takes one of the plan's allowance). */
export async function createPosRegisterHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as CreatePosRegisterInput;
    sendSuccess(res, await createPosRegister(storeId(req), req.userId ?? '', body), 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to create register');
  }
}

/** PATCH /:id — rename a live register. */
export async function renamePosRegisterHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as UpdatePosRegisterInput;
    sendSuccess(res, await renamePosRegister(storeId(req), routeParam(req, 'id'), body.name));
  } catch (err) {
    respondWithError(res, err, 'Failed to rename register');
  }
}

/** DELETE /:id — remove a live register (gives its allowance back). */
export async function removePosRegisterHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await removePosRegister(storeId(req), routeParam(req, 'id')));
  } catch (err) {
    log.general.error({ err, registerId: req.params.id }, 'Failed to remove POS register');
    respondWithError(res, err, 'Failed to remove register');
  }
}

/** GET /summary — daily POS sales per register, the default register included. */
export async function posRegisterSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    const locationId = queryString(req, 'locationId');
    sendSuccess(
      res,
      await getPosRegisterSalesSummary(storeId(req), {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(locationId ? { locationId } : {}),
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to read POS register summary');
    respondWithError(res, err, 'Failed to read register summary');
  }
}
