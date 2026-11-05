/**
 * Store merchandising rules controller (THIN) — the paid
 * `advanced_merchandising_rules` tool (#89), mounted at
 * `/admin/stores/:storeId/merchandising`.
 *
 * Scoped to the loaded store (`req.store`, set by `loadStore`). Enforcement —
 * what is consumed on create, released on delete, and gated on update and
 * preview — lives in `services/merchandising/merchandising-rule.service.ts`; a
 * plan refusal is a `PlanCapabilityRefusal`, which `respondWithError` answers as
 * 403 `PLAN_CAPABILITY_REQUIRED` or `PLAN_LIMIT_REACHED`.
 */

import type { Request, Response } from 'express';
import type {
  CreateMerchandisingRuleInput,
  MerchandisingPreviewInput,
  UpdateMerchandisingRuleInput,
} from '@mercaria/shared-types';
import {
  createMerchandisingRule,
  deleteMerchandisingRuleById,
  getMerchandisingRule,
  listMerchandisingRules,
  previewMerchandisingOrder,
  updateMerchandisingRuleById,
} from '../../services/merchandising/merchandising-rule.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

function storeId(req: Request): string {
  if (!req.store) throw notFound('Store not loaded');
  return req.store.id;
}

/** GET /rules — never gated. */
export async function listStoreMerchandisingRules(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listMerchandisingRules(storeId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to list merchandising rules');
    respondWithError(res, err, 'Failed to load merchandising rules');
  }
}

/** GET /rules/:id — never gated. */
export async function getStoreMerchandisingRule(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getMerchandisingRule(storeId(req), routeParam(req, 'id')));
  } catch (err) {
    respondWithError(res, err, 'Failed to load the merchandising rule');
  }
}

/** POST /rules — takes one unit of the plan allowance. */
export async function createStoreMerchandisingRule(req: Request, res: Response): Promise<void> {
  try {
    const rule = await createMerchandisingRule(
      storeId(req),
      req.body as CreateMerchandisingRuleInput,
    );
    sendSuccess(res, rule, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to create the merchandising rule');
  }
}

/** PATCH /rules/:id — gated: editing is the tool's own work. */
export async function patchStoreMerchandisingRule(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await updateMerchandisingRuleById(
        storeId(req),
        routeParam(req, 'id'),
        req.body as UpdateMerchandisingRuleInput,
      ),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to update the merchandising rule');
  }
}

/** DELETE /rules/:id — never gated; gives the unit back. */
export async function deleteStoreMerchandisingRule(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    await deleteMerchandisingRuleById(storeId(req), id);
    sendSuccess(res, { id, deleted: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to delete the merchandising rule');
  }
}

/** POST /preview — the order a draft sort rule would produce. Gated. */
export async function previewStoreMerchandising(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await previewMerchandisingOrder(storeId(req), req.body as MerchandisingPreviewInput),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to preview the merchandising order');
  }
}
