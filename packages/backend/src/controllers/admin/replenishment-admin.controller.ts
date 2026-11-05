/**
 * Replenishment planning controller (THIN), mounted at
 * `/admin/stores/:storeId/replenishment`. The store is `req.store` (`loadStore`);
 * the permissions are the router's; the capability check is the service's.
 */

import type { Request, Response } from 'express';
import type {
  ReplenishmentRowStatus,
  ReplenishmentSettingValues,
  UpsertReplenishmentOverrideInput,
} from '@mercaria/shared-types';
import {
  computeReplenishmentPlan,
  readReplenishmentSettings,
  removeReplenishmentOverride,
  setReplenishmentOverride,
  toReplenishmentCsv,
  updateReplenishmentSettings,
} from '../../services/replenishment/plan.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { routeParam } from '../../utils/request.js';
import { isMercariaError, notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

function storeId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

/** The query, after `validateQuery` has parsed it. */
interface PlanQuery {
  locationId?: string;
  status?: ReplenishmentRowStatus;
  limit?: number;
  format?: 'json' | 'csv';
}

/** GET …/settings — never gated: these are rows the store already saved. */
export async function getReplenishmentSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readReplenishmentSettings(storeId(req)));
  } catch (err) {
    respondWithError(res, err, 'Failed to load replenishment settings');
  }
}

/** PUT …/settings */
export async function putReplenishmentSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ReplenishmentSettingValues;
    sendSuccess(res, await updateReplenishmentSettings(storeId(req), body));
  } catch (err) {
    respondWithError(res, err, 'Failed to save replenishment settings');
  }
}

/** PUT …/overrides/:variantId */
export async function putReplenishmentOverrideHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as UpsertReplenishmentOverrideInput;
    sendSuccess(
      res,
      await setReplenishmentOverride(storeId(req), routeParam(req, 'variantId'), body),
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to save the variant override');
  }
}

/** DELETE …/overrides/:variantId — never gated. */
export async function deleteReplenishmentOverrideHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await removeReplenishmentOverride(storeId(req), routeParam(req, 'variantId')));
  } catch (err) {
    respondWithError(res, err, 'Failed to remove the variant override');
  }
}

/** GET …/plan — JSON, or `?format=csv` for the whole purchase-suggestion list. */
export async function getReplenishmentPlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as PlanQuery;
    const id = storeId(req);
    const csv = query.format === 'csv';
    const plan = await computeReplenishmentPlan({
      storeId: id,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(csv ? { limit: Number.POSITIVE_INFINITY } : query.limit ? { limit: query.limit } : {}),
    });
    if (csv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="replenishment-${plan.generatedAt.slice(0, 10)}.csv"`,
      );
      res.status(200).send(toReplenishmentCsv(plan));
      return;
    }
    sendSuccess(res, plan);
  } catch (err) {
    if (!isMercariaError(err)) {
      log.general.error({ err }, 'Failed to compute the replenishment plan');
    }
    respondWithError(res, err, 'Failed to compute the replenishment plan');
  }
}
