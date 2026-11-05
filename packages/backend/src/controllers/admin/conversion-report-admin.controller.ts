/**
 * The checkout conversion report's handlers (THIN) — the paid
 * `advanced_demand_analytics` tool (#89).
 *
 * The store scope comes from `req.store`, which `loadStore` set from a
 * membership check, never from a query parameter — the #77 summary's rule, and
 * what makes "their OWN orders" a property of the route.
 *
 * The plan gate is {@link requireConversionReportCapability}, mounted per route
 * AFTER `stats:read`: a member who may not read stats at all is told so before
 * anything about the plan, and a store whose plan lacks the tool is answered
 * 403 `PLAN_CAPABILITY_REQUIRED`. Nothing is stored by this tool, so a plan
 * ending deletes nothing — the reports simply stop being computed, and the
 * free summary and sales reports carry on unchanged.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  CONVERSION_REPORT_EXPORTS,
  CONVERSION_REPORT_INTERVALS,
  type ConversionReportExport,
  type ConversionReportInterval,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import {
  isMercariaError,
  notFound,
  respondWithError,
  validationError,
} from '../../lib/errors/error-codes.js';
import { sendSuccess } from '../../utils/api-response.js';
import { requireCapability } from '../../services/entitlements/enforce.js';
import {
  getConversionTrendReport,
  getListingConversionReport,
  listingReportCsv,
  resolveConversionWindow,
  trendReportCsv,
} from '../../services/conversion-report.service.js';

/** The capability this tool sells. */
const CAPABILITY = 'advanced_demand_analytics' as const;

/** The loaded store id (guaranteed by `loadStore`; refusing is the only safe reading of its absence). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not found');
  return store.id;
}

/** An optional string query parameter. */
function queryString(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** `?interval=`, defaulting to `day`; anything else is a 400. */
function intervalOf(req: Request): ConversionReportInterval {
  const raw = queryString(req, 'interval') ?? 'day';
  if (!(CONVERSION_REPORT_INTERVALS as readonly string[]).includes(raw)) {
    throw validationError(`interval must be one of ${CONVERSION_REPORT_INTERVALS.join(', ')}`);
  }
  return raw as ConversionReportInterval;
}

function windowOf(req: Request) {
  return resolveConversionWindow({ from: queryString(req, 'from'), to: queryString(req, 'to') });
}

/** Answer a failure; only an unexpected one is logged (a 400 is the caller's, not ours). */
function failed(res: Response, err: unknown, message: string): void {
  if (!isMercariaError(err)) log.general.error({ err }, message);
  respondWithError(res, err, message);
}

/** Refuse the request unless the store's plan includes the tool. */
export async function requireConversionReportCapability(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await requireCapability({ storeId: storeId(req), capability: CAPABILITY });
    next();
  } catch (err) {
    respondWithError(res, err, 'Failed to check the store plan');
  }
}

/** GET /admin/stores/:storeId/analytics/advanced/listings */
export async function getListingConversionHandler(req: Request, res: Response): Promise<void> {
  try {
    const report = await getListingConversionReport({
      storeId: storeId(req),
      window: windowOf(req),
    });
    sendSuccess(res, report);
  } catch (err) {
    failed(res, err, 'Failed to load the listing conversion report');
  }
}

/** GET /admin/stores/:storeId/analytics/advanced/trend */
export async function getConversionTrendHandler(req: Request, res: Response): Promise<void> {
  try {
    const report = await getConversionTrendReport({
      storeId: storeId(req),
      window: windowOf(req),
      interval: intervalOf(req),
    });
    sendSuccess(res, report);
  } catch (err) {
    failed(res, err, 'Failed to load the conversion trend');
  }
}

/**
 * GET /admin/stores/:storeId/analytics/advanced/export?report=listings|trend
 *
 * The same report the screen shows, as CSV — the figures the merchant is
 * entitled to see and nothing more (suppressed figures say so in the file).
 */
export async function exportConversionReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const raw = queryString(req, 'report') ?? 'listings';
    if (!(CONVERSION_REPORT_EXPORTS as readonly string[]).includes(raw)) {
      throw validationError(`report must be one of ${CONVERSION_REPORT_EXPORTS.join(', ')}`);
    }
    const kind = raw as ConversionReportExport;
    const id = storeId(req);
    const window = windowOf(req);
    const body =
      kind === 'trend'
        ? trendReportCsv(
            await getConversionTrendReport({ storeId: id, window, interval: intervalOf(req) }),
          )
        : listingReportCsv(await getListingConversionReport({ storeId: id, window }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="conversion-${kind}-${window.from}-${window.to}.csv"`,
    );
    res.status(200).send(body);
  } catch (err) {
    failed(res, err, 'Failed to export the conversion report');
  }
}
