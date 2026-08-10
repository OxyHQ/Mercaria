/**
 * The merchant-facing demand surfaces (#86) — THIN handlers.
 *
 * Two audiences and two types. `/merchant-demand/:merchantId` is the CLAIMED
 * merchant's dashboard and needs an authenticated caller the access resolver
 * admits; `/merchant-demand/:merchantId/preview` is the UNCLAIMED merchant's
 * bounded proof and needs nobody at all.
 *
 * ## Both refusals are the same 404
 *
 * A merchant that does not exist, one whose claim is somebody else's, one whose
 * store membership lacks `analytics:read` and — on the preview — one that IS
 * claimed all answer 404. A distinguishable response on any of them would let
 * anybody enumerate which merchants have been claimed, one request at a time.
 */

import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  readMerchantDemandDashboard,
  toDemandCsv,
  demandMetricCatalogue,
} from '../services/merchant-demand/dashboard.service.js';
import { readMerchantDemandPreview } from '../services/merchant-demand/preview.service.js';
import { resolveMerchantDemandAccess } from '../services/merchant-demand/access.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** The query, after `validateQuery` has parsed it. */
interface DemandQuery {
  market?: string;
  windowDays?: number;
  refresh?: 'true' | 'false';
  format?: 'json' | 'csv';
}

/** GET /merchant-demand/metrics — the definition catalogue, for a legend. */
export function listDemandMetricsHandler(_req: Request, res: Response): void {
  sendSuccess(res, { metrics: demandMetricCatalogue() });
}

/** GET /merchant-demand/:merchantId — the claimed merchant's dashboard. */
export async function getMerchantDemandHandler(req: Request, res: Response): Promise<void> {
  try {
    // The lever is re-read here as well as at the mount, because the two live in
    // different files and that is exactly the pair that drifts. 404 and never
    // 403: a merchant that cannot see its dashboard because a deployment turned
    // the feature off must not learn that the feature exists.
    if (!config.merchantDemand.dashboardEnabled) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    const merchantId = routeParam(req, 'merchantId');
    const oxyUserId = getRequiredOxyUserId(req);
    const access = await resolveMerchantDemandAccess({ merchantId, oxyUserId });
    if (access.outcome === 'refused') {
      // Logged with the reason so an operator can tell a misconfigured
      // permission from a wrong merchant id; the RESPONSE carries neither.
      log.general.info(
        { merchantId, reason: access.reason },
        '[MerchantDemand] refused a demand read',
      );
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    const query = req.query as DemandQuery;
    const view = await readMerchantDemandDashboard({
      merchantId,
      market: query.market === undefined ? '' : query.market.toUpperCase(),
      windowDays: query.windowDays ?? config.merchantDemand.defaultWindowDays,
      refresh: query.refresh === 'true',
    });

    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="merchant-demand-${merchantId}.csv"`,
      );
      res.status(200).send(toDemandCsv(view));
      return;
    }

    sendSuccess(res, view);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read merchant demand');
  }
}

/**
 * GET /merchant-demand/:merchantId/preview — the unclaimed merchant's proof.
 *
 * Unauthenticated by design: it is what a claim flow shows somebody who has not
 * proved anything yet. Everything it can disclose is rounded, floored and
 * counted in visit nouns.
 */
export async function getMerchantDemandPreviewHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!config.merchantDemand.previewEnabled) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    const query = req.query as DemandQuery;
    const preview = await readMerchantDemandPreview({
      merchantId: routeParam(req, 'merchantId'),
      market: query.market === undefined ? '' : query.market.toUpperCase(),
      windowDays: query.windowDays ?? config.merchantDemand.defaultWindowDays,
    });
    sendSuccess(res, preview);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read the merchant demand preview');
  }
}
