/**
 * Price-history controllers (THIN) — the public read and the operator surface
 * (#78 §"API and UI", §"Operations").
 *
 * Nothing here derives anything. The gap ranges, the unbuilt ranges, the
 * summary sentences, the data table, the display-only notice and the
 * current-offer link are all composed in `services/price-history/read.service.ts`,
 * so a controller cannot produce a second answer to any of them — and there is
 * no DTO field a serializer could widen into a referral partner, a commission
 * or a campaign, because `PRICE_HISTORY_FORBIDDEN_DTO_FIELDS` names all of them
 * and a test walks a real emitted response for each.
 */

import type { Request, Response } from 'express';
import {
  PRICE_HISTORY_POLICY_VERSION,
  type ConditionGroup,
  type CurrencyCode,
  type PriceSeriesGranularity,
  type PriceSeriesMeasure,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { requestPriceSeriesRebuild } from '../db/priceHistory/priceSeriesRepository.js';
import {
  readPriceHistoryMetrics,
  tracePriceHistoryForOffer,
} from '../services/price-history/metrics.service.js';
import { clampPriceHistoryRange, readPriceHistory } from '../services/price-history/read.service.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

interface PriceHistoryQueryParams {
  canonicalProductId?: string;
  canonicalVariantId?: string;
  market?: string;
  currency: CurrencyCode;
  segment: ConditionGroup;
  measure: PriceSeriesMeasure;
  granularity: PriceSeriesGranularity;
  from: string;
  to: string;
  merchantId?: string;
  storefrontId?: string;
  allowCurrentRateReinterpretation?: 'true' | 'false';
}

/**
 * GET /price-history — one series, with its gaps, its uncovered ranges, its
 * accessible summary and its data table.
 *
 * The range is CLAMPED rather than refused when it exceeds what the domain
 * keeps: a caller asking for five years gets the window that exists, with the
 * rest reported as `uncovered` rather than as an error they cannot act on.
 */
export async function getPriceHistoryHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as PriceHistoryQueryParams;
    const now = new Date();
    const range = clampPriceHistoryRange(new Date(query.from), new Date(query.to), now);

    const response = await readPriceHistory(
      {
        scope: {
          kind: query.canonicalProductId ? 'canonical_product' : 'canonical_variant',
          ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
          ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
          ...(query.market ? { market: query.market.toUpperCase() } : {}),
          displayCurrency: query.currency,
          granularity: query.granularity,
        },
        measure: query.measure,
        segment: query.segment,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.storefrontId ? { storefrontId: query.storefrontId } : {}),
        allowCurrentRateReinterpretation: query.allowCurrentRateReinterpretation === 'true',
      },
      now,
    );

    sendSuccess(res, response);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read price history');
  }
}

/** GET /internal/price-history/metrics — write volume, dedup rate, aggregation lag. */
export async function priceHistoryMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { windowDays } = req.query as unknown as { windowDays: number };
    sendSuccess(res, await readPriceHistoryMetrics(windowDays));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read price-history metrics');
  }
}

/**
 * GET /internal/price-history/offers/:offerId — one offer's observation trail.
 *
 * The trace opens from an OFFER id and nothing else. There is no handle here
 * for a buyer, a session or a merchant's account: a price history is a record
 * of what sellers published, and a surface that could be asked "show me
 * everything this person saw" is a different thing entirely.
 */
export async function priceHistoryOfferTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await tracePriceHistoryForOffer(routeParam(req, 'offerId')));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace price history');
  }
}

/**
 * POST /internal/price-history/series/rebuild — re-arm one series now.
 *
 * It DRIVES the existing idempotent path: the enqueue is the same
 * `ON CONFLICT DO UPDATE` an observation performs, and the dispatcher rebuilds
 * with the same derivation. So this surface adds a TRIGGER and no new way for a
 * point to come into being.
 */
export async function priceHistoryRebuildHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      canonicalProductId?: string;
      canonicalVariantId?: string;
      market?: string;
      currency: CurrencyCode;
      granularity: PriceSeriesGranularity;
    };

    await requestPriceSeriesRebuild(
      {
        scopeKind: body.canonicalProductId ? 'canonical_product' : 'canonical_variant',
        canonicalProductId: body.canonicalProductId ?? null,
        canonicalVariantId: body.canonicalVariantId ?? null,
        market: body.market ? body.market.toUpperCase() : null,
        displayCurrency: body.currency,
        granularity: body.granularity,
      },
      PRICE_HISTORY_POLICY_VERSION,
      getDb(),
    );

    sendSuccess(res, { requested: true }, 202);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to request a price-series rebuild');
  }
}
