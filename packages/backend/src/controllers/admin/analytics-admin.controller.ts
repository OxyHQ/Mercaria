/**
 * The merchant-facing discovery analytics handler (#77 "Merchant analytics").
 *
 * One endpoint, one projection, and the projection is the enforcement: it has
 * no field for a user, a guest, a query string, a contact, a portal access, a
 * claim status or a payment-method identity, so merchant rules 3 and 4 cannot
 * be violated by a future change to this file — only by adding a field to the
 * DTO, which `MerchantAnalyticsSummary`'s own docblock forbids.
 *
 * The store scope comes from `req.store`, which `loadStore` set from a
 * membership check, and never from a query parameter. That is what makes "their
 * OWN offers" a property of the route rather than a filter this handler has to
 * get right.
 */

import type { Request, Response } from 'express';
import { ANALYTICS_MERCHANT_MIN_COHORT } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { ErrorCodes, sendError, sendSuccess } from '../../utils/api-response.js';
import { getMerchantAnalyticsSummary } from '../../services/analytics/merchant-analytics.service.js';

/** How many days back a summary may span. */
const MAX_WINDOW_DAYS = 92;

/** Read a `YYYY-MM-DD` query parameter. */
function dateParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (typeof raw !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/** `YYYY-MM-DD`, n days before the given date. */
function daysBefore(date: Date, days: number): string {
  return new Date(date.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * GET /admin/stores/:storeId/analytics/summary
 *
 * Defaults to the last 28 days when no window is given — long enough that a
 * small store clears the cohort threshold, which is the difference between a
 * useful surface and one that is permanently suppressed.
 */
export async function getStoreAnalyticsHandler(req: Request, res: Response): Promise<void> {
  const store = req.store;
  if (!store) {
    // `loadStore` runs first and answers 404 itself; reaching here storeless is
    // a bug, and refusing is the only safe reading of it.
    sendError(res, ErrorCodes.NOT_FOUND, 'Store not found', 404);
    return;
  }

  const now = new Date();
  const to = dateParam(req, 'to') ?? now.toISOString().slice(0, 10);
  const from = dateParam(req, 'from') ?? daysBefore(now, 28);

  if (from > to) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'from must not be after to', 400);
    return;
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays > MAX_WINDOW_DAYS) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      `the window may span at most ${String(MAX_WINDOW_DAYS)} days`,
      400,
    );
    return;
  }

  try {
    const summary = await getMerchantAnalyticsSummary({ storeId: store.id, from, to });
    sendSuccess(res, {
      ...summary,
      // Shipped beside the figures so a client renders WHY a suppressed
      // summary is zero. A zero with no explanation reads as "nothing
      // happened", which is a different and more discouraging fact.
      minimumCohort: ANALYTICS_MERCHANT_MIN_COHORT,
    });
  } catch (err: unknown) {
    log.general.error({ err, storeId: store.id }, '[Analytics] merchant summary failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load analytics', 500);
  }
}
