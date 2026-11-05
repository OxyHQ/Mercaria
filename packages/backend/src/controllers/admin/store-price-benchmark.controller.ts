/**
 * A store's competitive price analytics (#89's `competitive_price_analytics`) — THIN.
 *
 * Nothing here derives anything: every figure, band and refusal is composed in
 * `services/store-price-benchmark/`, and the CSV is a rendering of exactly the
 * rows the JSON carries. The store is `req.store`, which `loadStore` resolved
 * from a membership check — never a value from the query — so "the store's own
 * listings" is a property of the route.
 *
 * It is a `flag` tool, and every route here computes a NEW report, so every
 * route asks {@link requirePriceAnalyticsCapability}. The tool creates no rows,
 * so there is nothing of the store's that a refusal could withhold.
 */

import type { NextFunction, Request, Response } from 'express';
import type { StorePriceTrendGranularity, StorePriceTrendWindowDays } from '@mercaria/shared-types';
import { requireCapability } from '../../services/entitlements/enforce.js';
import {
  readStorePriceAnalytics,
  readStorePriceTrend,
} from '../../services/store-price-benchmark/benchmark.service.js';
import { toStorePriceAnalyticsCsv } from '../../services/store-price-benchmark/csv.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { ErrorCodes, sendError, sendSuccess } from '../../utils/api-response.js';
import { routeParam } from '../../utils/request.js';

/** The capability every route of this surface requires. */
export const PRICE_ANALYTICS_CAPABILITY = 'competitive_price_analytics' as const;

function storeIdOf(req: Request, res: Response): string | undefined {
  const store = req.store;
  if (!store) {
    // `loadStore` answers 404 itself; reaching here storeless is a bug, and
    // refusing is the only safe reading of it.
    sendError(res, ErrorCodes.NOT_FOUND, 'Store not found', 404);
    return undefined;
  }
  return store.id;
}

/**
 * The plan gate: 403 `PLAN_CAPABILITY_REQUIRED` for a store whose plan lacks
 * the tool. Mounted AFTER the permission check, so a member who may not read
 * analytics learns nothing about the store's plan.
 */
export async function requirePriceAnalyticsCapability(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const storeId = storeIdOf(req, res);
  if (storeId === undefined) return;
  try {
    await requireCapability({ storeId, capability: PRICE_ANALYTICS_CAPABILITY });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to check the store plan');
    return;
  }
  next();
}

/** GET /admin/stores/:storeId/price-analytics/listings — `format=csv` is the export. */
export async function getStorePriceAnalyticsHandler(req: Request, res: Response): Promise<void> {
  const storeId = storeIdOf(req, res);
  if (storeId === undefined) return;
  try {
    const query = req.query as unknown as { market?: string; format: 'json' | 'csv' };
    const response = await readStorePriceAnalytics({
      storeId,
      ...(query.market === undefined ? {} : { market: query.market }),
    });
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="price-analytics.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(toStorePriceAnalyticsCsv(response));
      return;
    }
    sendSuccess(res, response);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read price analytics');
  }
}

/** GET /admin/stores/:storeId/price-analytics/listings/:productVariantId/trend */
export async function getStorePriceTrendHandler(req: Request, res: Response): Promise<void> {
  const storeId = storeIdOf(req, res);
  if (storeId === undefined) return;
  try {
    const query = req.query as unknown as {
      market?: string;
      windowDays: StorePriceTrendWindowDays;
      granularity: StorePriceTrendGranularity;
    };
    sendSuccess(
      res,
      await readStorePriceTrend({
        storeId,
        productVariantId: routeParam(req, 'productVariantId'),
        windowDays: query.windowDays,
        granularity: query.granularity,
        ...(query.market === undefined ? {} : { market: query.market }),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read the price trend');
  }
}
