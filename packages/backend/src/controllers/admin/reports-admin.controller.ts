/**
 * Store reports controller (THIN) — the store analytics read path (B7).
 *
 * Every report is scoped to the loaded store (`req.store`, set by `loadStore`):
 * a member may only read analytics for their own store. All aggregation logic
 * lives in `report.service`; these handlers parse the validated query and return
 * the `ReportSummary` / `SalesReportPoint[]` / `TopProduct[]` DTOs. Reads are
 * gated on `stats:read` at the router.
 */

import type { Request, Response } from 'express';
import type { SalesReportInterval } from '@mercaria/shared-types';
import {
  getSummary,
  getSalesReport,
  getTopProducts,
} from '../../services/report.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return String((store as { _id: unknown })._id);
}

/** Read an optional string query param (Express types query values loosely). */
function queryString(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === 'string' ? raw : undefined;
}

/** GET /admin/stores/:storeId/reports/summary — single-snapshot order summary. */
export async function getReportSummary(req: Request, res: Response): Promise<void> {
  try {
    const summary = await getSummary(storeId(req));
    sendSuccess(res, summary);
  } catch (err) {
    log.general.error({ err }, 'Failed to load report summary');
    respondWithError(res, err, 'Failed to load report summary');
  }
}

/** GET /admin/stores/:storeId/reports/sales — time-bucketed sales over a range. */
export async function getSalesReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const rawInterval = queryString(req, 'interval');
    const interval =
      rawInterval === 'day' || rawInterval === 'week' || rawInterval === 'month'
        ? (rawInterval as SalesReportInterval)
        : undefined;
    const points = await getSalesReport(storeId(req), {
      from: queryString(req, 'from'),
      to: queryString(req, 'to'),
      interval,
    });
    sendSuccess(res, points);
  } catch (err) {
    log.general.error({ err }, 'Failed to load sales report');
    respondWithError(res, err, 'Failed to load sales report');
  }
}

/** GET /admin/stores/:storeId/reports/top-products — best sellers over a range. */
export async function getTopProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rawLimit = queryString(req, 'limit');
    const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : undefined;
    const products = await getTopProducts(storeId(req), {
      from: queryString(req, 'from'),
      to: queryString(req, 'to'),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    sendSuccess(res, products);
  } catch (err) {
    log.general.error({ err }, 'Failed to load top products');
    respondWithError(res, err, 'Failed to load top products');
  }
}
