/**
 * The eBay operator surface — issue #65's three questions an operator actually
 * has, and nothing else.
 *
 * *What is this source discovering?* (the rollout cohort), *how much of today's
 * quota is left?* (issue acceptance 4, "source quota and freshness metrics are
 * visible"), and *does what Mercaria serves still match what eBay says?*
 * (reliability 7).
 *
 * ## What is deliberately absent
 *
 * - **No credential read or write.** The source config carries a LOCATOR and the
 *   secret lives where the locator says. A route that accepted one would make
 *   this the second place secrets live, and the token is never written down at
 *   all (`services/ebay/token.ts`).
 * - **No "retire this item" and no "mark this source complete".** Retirement is
 *   #62's, authorised only by a complete enumeration, and a button that granted
 *   it would be the one mechanism able to mass-expire a healthy catalogue.
 * - **No campaign-id write.** `EPN_CAMPAIGN_ID` is read at boot; a route that
 *   changed it at runtime would make "which campaign was attributed at 14:00"
 *   unanswerable from configuration.
 * - **No budget write.** `EBAY_DAILY_CALL_LIMIT` is what eBay granted. A route
 *   that raised it would raise Mercaria's opinion of the allowance and nothing
 *   else, and the first symptom would be eBay throttling the application.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { EbayDiscoveryQueryKind, EbayMarketplaceId } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import { listEbayCallBudgets } from '../db/ebay/ebayBudgetRepository.js';
import { countTrackedEbayItems } from '../db/ebay/ebayCohortRepository.js';
import {
  listEbayDiscoveryQueries,
  upsertEbayDiscoveryQuery,
} from '../db/ebay/ebayDiscoveryRepository.js';
import {
  listEbayReconciliationSamples,
  summarizeEbayReconciliation,
} from '../db/ebay/ebayReconciliationRepository.js';
import {
  reconcileEbaySourceSchema,
  upsertEbayDiscoveryQuerySchema,
} from '../middleware/ebay-schemas.js';
import { reconcileEbaySource } from '../services/ebay/reconciliation.js';

/** How many budget days and samples a listing returns. Bounded, never paged. */
const OPERATOR_LIST_LIMIT = 100;

/** How far back a reconciliation summary looks. One week of sweeps. */
const RECONCILIATION_SUMMARY_DAYS = 7;

/** GET `/internal/ebay/sources/:sourceId/discovery-queries`. */
export async function listEbayDiscoveryQueriesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const rows = await listEbayDiscoveryQueries(getDb(), sourceId);
    sendSuccess(res, {
      sourceId,
      trackedItems: await countTrackedEbayItems(getDb(), sourceId),
      queries: rows.map((row) => ({
        id: row.id,
        marketplaceId: row.marketplaceId,
        queryKind: row.queryKind,
        queryValue: row.queryValue,
        position: row.position,
        enabled: row.enabled,
        maxOffset: row.maxOffset,
        lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
        lastItemCount: row.lastItemCount,
        note: row.note,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list the discovery queries');
  }
}

/** POST `/internal/ebay/sources/:sourceId/discovery-queries` — widen or narrow the cohort. */
export async function upsertEbayDiscoveryQueryHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const operator = getRequiredOxyUserId(req);
    const body = upsertEbayDiscoveryQuerySchema.parse(req.body);
    const row = await upsertEbayDiscoveryQuery(getDb(), {
      sourceId,
      marketplaceId: body.marketplaceId as EbayMarketplaceId,
      queryKind: body.queryKind as EbayDiscoveryQueryKind,
      queryValue: body.queryValue,
      position: body.position ?? 0,
      enabled: body.enabled ?? true,
      maxOffset: body.maxOffset ?? 1_000,
      createdByOxyUserId: operator,
      note: body.note ?? null,
    });
    sendSuccess(
      res,
      {
        id: row.id,
        marketplaceId: row.marketplaceId,
        queryKind: row.queryKind,
        queryValue: row.queryValue,
        position: row.position,
        enabled: row.enabled,
        maxOffset: row.maxOffset,
      },
      201,
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to configure the discovery query');
  }
}

/**
 * GET `/internal/ebay/budget` — issue acceptance 4's quota metric.
 *
 * `callsRefused` is reported beside `callsUsed` and the pair is the point:
 * `callsUsed` alone cannot tell a quiet day from a day the budget spent hours
 * refusing everything, and those need opposite responses (leave it alone; file
 * eBay's application growth check).
 */
export async function ebayBudgetHandler(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await listEbayCallBudgets(getDb(), { limit: OPERATOR_LIST_LIMIT });
    sendSuccess(res, {
      configuredDailyLimit: config.ebay.dailyCallLimit,
      environment: config.ebay.environment,
      markets: config.ebay.markets,
      attributionEnabled: config.ebay.attributionEnabled,
      fetchEnabled: config.ebay.fetchEnabled,
      days: rows.map((row) => ({
        // The application key is a DIGEST of a locator and is reported to its
        // first eight characters: enough to tell two keysets apart in a report,
        // and not a value anybody could put back into a lookup.
        applicationKey: row.applicationKey.slice(0, 8),
        budgetDate: row.budgetDate,
        dailyLimit: row.dailyLimit,
        callsUsed: row.callsUsed,
        callsRefused: row.callsRefused,
        lastCallAt: row.lastCallAt?.toISOString() ?? null,
        lastRefusedAt: row.lastRefusedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the eBay call budget');
  }
}

/** GET `/internal/ebay/sources/:sourceId/reconciliation` — the findings and their summary. */
export async function ebayReconciliationHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const since = new Date(Date.now() - RECONCILIATION_SUMMARY_DAYS * 86_400_000);
    const [samples, summary] = await Promise.all([
      listEbayReconciliationSamples(getDb(), { sourceId, limit: OPERATOR_LIST_LIMIT }),
      summarizeEbayReconciliation(getDb(), { sourceId, since }),
    ]);
    sendSuccess(res, {
      sourceId,
      windowDays: RECONCILIATION_SUMMARY_DAYS,
      summary,
      samples: samples.map((row) => ({
        externalId: row.externalId,
        finding: row.finding,
        checkedAt: row.checkedAt.toISOString(),
        storedPrice:
          row.storedPriceAmount === null || row.storedPriceCurrency === null
            ? null
            : { amount: row.storedPriceAmount, currency: row.storedPriceCurrency },
        providerPrice:
          row.providerPriceAmount === null || row.providerPriceCurrency === null
            ? null
            : { amount: row.providerPriceAmount, currency: row.providerPriceCurrency },
        providerAvailability: row.providerAvailability,
        providerCondition: row.providerCondition,
        providerAffiliateUrlPresent: row.providerAffiliateUrlPresent,
        note: row.note,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the reconciliation samples');
  }
}

/**
 * POST `/internal/ebay/sources/:sourceId/reconcile` — run one sweep now.
 *
 * It DETECTS and repairs nothing (the `payment_discrepancies` posture), and it
 * spends the same budget every other call does — a sweep that ignored the
 * allowance would fix a measurement problem by creating a freshness one.
 */
export async function reconcileEbaySourceHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    reconcileEbaySourceSchema.parse(req.body ?? {});
    const report = await reconcileEbaySource({ sourceId });
    sendSuccess(res, report);
  } catch (err) {
    respondWithError(res, err, 'Failed to reconcile the eBay source');
  }
}
