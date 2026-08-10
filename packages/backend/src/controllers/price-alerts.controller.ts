/**
 * Price-alert controllers (THIN) — the buyer's surface and the operator's (#79).
 *
 * Every decision lives in `services/price-alerts/`. What is here is the
 * request→service→envelope wiring and the one thing a controller must own: the
 * caller's identity, taken from the verified credential with
 * `getRequiredOxyUserId` and NEVER from a body or a query field. An alert holds
 * a buyer's own price target, so a request able to name a different account
 * would be an IDOR over what other people are waiting for.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  ConditionGroup,
  CurrencyCode,
  Money,
  PriceAlertAvailabilityRequirement,
  PriceAlertComparisonBasis,
  PriceAlertRepeatPolicy,
  PriceAlertSellerScope,
  PriceAlertSplitResolution,
} from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import {
  createPriceAlert,
  deletePriceAlert,
  getPriceAlert,
  listPriceAlerts,
  resolvePriceAlertSplit,
  suggestPriceAlertTarget,
  updatePriceAlert,
} from '../services/price-alerts/alert.service.js';
import {
  readPriceAlertMetrics,
  requestPriceAlertReevaluation,
  tracePriceAlert,
} from '../services/price-alerts/operator.service.js';

interface CreateBody {
  canonicalProductId: string;
  canonicalVariantId?: string;
  target: Money;
  basis: PriceAlertComparisonBasis;
  conditionGroups?: ConditionGroup[];
  market?: string;
  sellerScope?: PriceAlertSellerScope;
  merchantId?: string;
  storefrontId?: string;
  availabilityRequirement?: PriceAlertAvailabilityRequirement;
  minimumAvailableQuantity?: number;
  requirePickupAvailable?: boolean;
  repeatPolicy?: PriceAlertRepeatPolicy;
  resetThreshold?: Money;
  cooldownSeconds?: number;
  quietHours?: { startMinute: number; endMinute: number; timeZone: string };
  locale?: string;
  emailOptIn?: boolean;
}

/** POST /price-alerts */
export async function createPriceAlertHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const alert = await createPriceAlert({ oxyUserId, ...(req.body as CreateBody) });
    sendSuccess(res, { alert }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create a price alert');
    respondWithError(res, err, 'Failed to create that price alert');
  }
}

/** GET /price-alerts */
export async function listPriceAlertsHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const query = req.query as { canonicalProductId?: string; limit?: number; offset?: number };
    const alerts = await listPriceAlerts({
      oxyUserId,
      ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
      limit: query.limit ?? 50,
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    sendSuccess(res, { alerts });
  } catch (err) {
    log.general.error({ err }, 'Failed to list price alerts');
    respondWithError(res, err, 'Failed to list your price alerts');
  }
}

/**
 * GET /price-alerts/suggestion
 *
 * Reads only, creates nothing — UX rule 2. The route is deliberately NOT
 * `POST /price-alerts/suggestion`: a suggestion is a question about the
 * catalogue and a verb that writes would invite one.
 */
export async function priceAlertSuggestionHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      canonicalProductId: string;
      currency: CurrencyCode;
      market?: string;
      conditionGroups?: ConditionGroup | ConditionGroup[];
    };
    const groups = query.conditionGroups
      ? Array.isArray(query.conditionGroups)
        ? query.conditionGroups
        : [query.conditionGroups]
      : undefined;
    const suggestion = await suggestPriceAlertTarget({
      canonicalProductId: query.canonicalProductId,
      currency: query.currency,
      ...(query.market ? { market: query.market } : {}),
      ...(groups ? { conditionGroups: groups } : {}),
    });
    sendSuccess(res, { suggestion });
  } catch (err) {
    log.general.error({ err }, 'Failed to suggest a price-alert target');
    respondWithError(res, err, 'Failed to read the current price for that product');
  }
}

/** GET /price-alerts/:alertId */
export async function getPriceAlertHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, { alert: await getPriceAlert(alertId, oxyUserId) });
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to read a price alert');
    respondWithError(res, err, 'Failed to read that price alert');
  }
}

/** PATCH /price-alerts/:alertId — edit, pause or resume (notification 8). */
export async function updatePriceAlertHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const alert = await updatePriceAlert(alertId, oxyUserId, req.body as Record<string, never>);
    sendSuccess(res, { alert });
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to update a price alert');
    respondWithError(res, err, 'Failed to update that price alert');
  }
}

/** DELETE /price-alerts/:alertId — idempotent. */
export async function deletePriceAlertHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await deletePriceAlert(alertId, oxyUserId);
    sendSuccess(res, { deleted: true });
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to delete a price alert');
    respondWithError(res, err, 'Failed to delete that price alert');
  }
}

/** POST /price-alerts/:alertId/resolve-split */
export async function resolvePriceAlertSplitHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as { resolution: PriceAlertSplitResolution };
    const alert = await resolvePriceAlertSplit({ id: alertId, oxyUserId, ...body });
    sendSuccess(res, { alert });
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to resolve a price-alert split');
    respondWithError(res, err, 'Failed to resolve that price alert');
  }
}

/** GET /internal/price-alerts/metrics */
export async function priceAlertMetricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readPriceAlertMetrics());
  } catch (err) {
    log.general.error({ err }, 'Failed to read price-alert metrics');
    respondWithError(res, err, 'Failed to read the price-alert metrics');
  }
}

/** GET /internal/price-alerts/alerts/:alertId — the trace. */
export async function priceAlertTraceHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    sendSuccess(res, await tracePriceAlert(alertId));
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to trace a price alert');
    respondWithError(res, err, 'Failed to trace that price alert');
  }
}

/** POST /internal/price-alerts/alerts/:alertId/evaluate — drive the existing path. */
export async function priceAlertReevaluateHandler(req: Request, res: Response): Promise<void> {
  const alertId = routeParam(req, 'alertId');
  try {
    await requestPriceAlertReevaluation(alertId);
    sendSuccess(res, { enqueued: true });
  } catch (err) {
    log.general.error({ err, alertId }, 'Failed to request a price-alert evaluation');
    respondWithError(res, err, 'Failed to request that evaluation');
  }
}
