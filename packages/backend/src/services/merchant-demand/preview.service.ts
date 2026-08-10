/**
 * The bounded proof an UNCLAIMED merchant may be shown (#86 §"Unclaimed
 * merchant preview").
 *
 * ## Six rules, and five of them are held by something other than the copy
 *
 *  1. **Rounded or thresholded counts** — `roundPreviewCount` rounds DOWN to two
 *     significant figures, and `MERCHANT_DEMAND_PREVIEW_MIN_COUNT` withholds
 *     anything under it. Down rather than to nearest, because a rounded figure
 *     shown to a merchant in a pitch must never be larger than what happened.
 *  2. **Never a named user, an exact low-frequency query or a private list** —
 *     `MerchantDemandPreview` has no field for any of them, and no product rows
 *     at all. A response with no field for a thing cannot leak the thing.
 *  3. **Say visits or clicks unless a conversion is reported** — every metric on
 *     the preview list carries a `noun` from
 *     `MERCHANT_DEMAND_COUNT_NOUNS`, none of which is a sales word, and the list
 *     itself excludes every conversion and money metric BY NAME.
 *  4. **Never invent attributed sales** — same list, plus the kinds: a click is
 *     an `observed_interaction` and can never be added to an
 *     `affiliate_conversion`.
 *  5. **State the time range and freshness** — both are required fields on the
 *     response type.
 *  6. **Require enough data to prevent inference about one person** — the
 *     preview floor is five times the aggregate floor, because the reader here
 *     is whoever asked.
 *
 * ## The preview is a DIFFERENT TYPE, not a filtered dashboard
 *
 * `MerchantDemandPreview` is built field by field from a snapshot; it is not
 * `MerchantDemandSnapshotView` with things removed. The `MerchantOrder` device:
 * a serializer that reached for a product row or an amount would fail `tsc`
 * rather than ship it.
 *
 * ## It is shown for an UNCLAIMED merchant only
 *
 * A claimant has the dashboard, which is strictly more. Serving a
 * preview for a claimed merchant would put a rounded figure and an exact one
 * side by side for the same window — and the difference between them is a
 * disclosure the rounding exists to prevent.
 */

import { eq } from 'drizzle-orm';
import {
  MERCHANT_DEMAND_PREVIEW_MIN_COUNT,
  MERCHANT_DEMAND_PREVIEW_METRIC_KEYS,
  roundPreviewCount,
  type MerchantDemandPreview,
  type MerchantDemandValue,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { merchants } from '../../db/schema/merchants.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { requireMerchantDemandMetric } from './metrics.js';
import { projectSnapshot, resolveWindow } from './dashboard.service.js';
import { buildMerchantDemandSnapshot } from './snapshot.service.js';
import { findLiveSnapshot } from '../../db/merchantDemand/merchantDemandSnapshotRepository.js';

/** What the preview was asked for. */
export interface MerchantDemandPreviewRequest {
  readonly merchantId: string;
  readonly market: string;
  readonly windowDays: number;
  readonly now?: Date;
}

/** Apply the preview's own rounding and floor to a dashboard value. */
export function toPreviewValue(value: MerchantDemandValue): MerchantDemandValue {
  if (value.state !== 'measured') {
    // A suppressed figure is re-stated at the PREVIEW's floor, not the
    // dashboard's. Passing the lower floor through would tell an
    // unauthenticated reader that the count was under ten, which is a tighter
    // bound than the preview is allowed to disclose.
    if (value.state === 'suppressed') {
      return { state: 'suppressed', floor: MERCHANT_DEMAND_PREVIEW_MIN_COUNT };
    }
    return value;
  }
  if (value.measure.unit !== 'count') {
    // Structurally unreachable — the preview list contains only count metrics —
    // and answering `suppressed` rather than rendering it is the fail-closed
    // direction if that ever stops being true.
    return { state: 'suppressed', floor: MERCHANT_DEMAND_PREVIEW_MIN_COUNT };
  }
  if (value.measure.count < MERCHANT_DEMAND_PREVIEW_MIN_COUNT) {
    return { state: 'suppressed', floor: MERCHANT_DEMAND_PREVIEW_MIN_COUNT };
  }
  return {
    state: 'measured',
    measure: { unit: 'count', count: roundPreviewCount(value.measure.count) },
  };
}

/**
 * Build one unclaimed merchant's preview.
 *
 * Answers 404 — the same 404 an unknown merchant gets — for a merchant whose
 * `claim_state` is `claimed`. There is no separate "already claimed" response, because a
 * distinguishable one is an oracle for which merchants have been claimed.
 */
export async function readMerchantDemandPreview(
  request: MerchantDemandPreviewRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantDemandPreview> {
  const merchantRows = await db
    .select({ id: merchants.id, claimState: merchants.claimState })
    .from(merchants)
    .where(eq(merchants.id, request.merchantId))
    .limit(1);
  const merchant = merchantRows[0];
  if (merchant === undefined || merchant.claimState === 'claimed') {
    throw notFound('Merchant not found');
  }

  const window = resolveWindow({
    merchantId: request.merchantId,
    market: request.market,
    windowDays: request.windowDays,
    refresh: false,
    ...(request.now === undefined ? {} : { now: request.now }),
  });

  const live = await findLiveSnapshot(
    { merchantId: request.merchantId, market: request.market },
    db,
  );
  const stored =
    live !== undefined &&
    live.snapshot.windowFrom.getTime() === window.from.getTime() &&
    live.snapshot.windowTo.getTime() === window.to.getTime()
      ? live
      : await buildMerchantDemandSnapshot(
          {
            merchantId: request.merchantId,
            market: request.market,
            windowFrom: window.from,
            windowTo: window.to,
            now: window.now,
          },
          db,
        );

  const view = projectSnapshot(stored);
  const byKey = new Map(view.metrics.map((metric) => [metric.metricKey, metric]));

  const lines = MERCHANT_DEMAND_PREVIEW_METRIC_KEYS.map((key) => {
    const definition = requireMerchantDemandMetric(key);
    const metric = byKey.get(key);
    return {
      metricKey: key,
      noun: definition.noun,
      title: definition.title,
      value:
        metric === undefined
          ? ({ state: 'unavailable', reason: 'collection_disabled' } as MerchantDemandValue)
          : toPreviewValue(metric.value),
      attributionLimit: definition.attributionLimit,
    };
  });

  return {
    merchantId: view.merchantId,
    market: view.market,
    windowFrom: view.windowFrom,
    windowTo: view.windowTo,
    dataFreshAsOf: view.dataFreshAsOf,
    lines,
    disclosure: {
      rounding: 'Counts are rounded DOWN to two significant figures.',
      floor: MERCHANT_DEMAND_PREVIEW_MIN_COUNT,
      limitation:
        'These are visits and views Mercaria observed on its own surfaces. They are not ' +
        'sales, and Mercaria does not claim to have caused a purchase.',
    },
  };
}
