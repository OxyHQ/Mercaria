/**
 * Offer comparison controller (THIN) — the public ranked read (#74).
 *
 * Everything is delegated to `services/ranking/`. Nothing here scores, labels,
 * excludes or orders anything: issue policy rule 2 says the weights and rules
 * live in a tested domain module and not in a UI component, and a controller
 * that derived any of it would be the first place a second answer appeared.
 *
 * ## This is where #77's `#74` seam is CLOSED
 *
 * Every `offer_impression` carries `rankingPolicyVersion`, so a measured result
 * can always be attributed to the policy that produced it (issue policy rule 1).
 * `analytics_events.ranking_policy_version` existed and was NULL because nothing
 * supplied it; the value is supplied here and nothing in the analytics domain
 * had to change, which is exactly what its seam contract said would happen.
 *
 * The emitter is the ONLY analytics module this file may import.
 * `analytics-ranking-isolation.test.ts` fails the build on any other: a
 * comparison surface that could read a rollup is one join from ordering by
 * measured popularity, which is one join from ordering by who pays for
 * impressions.
 */

import type { Request, Response } from 'express';
import type {
  ConditionGroup,
  CurrencyCode,
  ItemConditionKey,
  OfferComparisonExperience,
  OfferComparisonIntent,
  OfferCustomerEligibility,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { rankOfferComparison } from '../services/ranking/comparison.service.js';
import {
  DEFAULT_PRESENTMENT_CURRENCY,
  resolvePresentmentCurrency,
} from '../services/user-preference.service.js';
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * The currency this comparison names.
 *
 * A signed-in buyer's STORED preference is authoritative and the query parameter
 * is ignored for them — `cart.service`'s rule, and for its reason: a preference
 * they set is a decision, and a link somebody sent them is not. A viewer with no
 * account gets the parameter, else the display default. The default lives in
 * `user-preference.service` and NOT in the ranking domain, which names no
 * currency at all.
 */
async function resolveComparisonCurrency(
  req: Request,
  requested: CurrencyCode | undefined,
): Promise<CurrencyCode> {
  const oxyUserId = req.user?.id;
  if (oxyUserId) return resolvePresentmentCurrency(oxyUserId);
  return requested ?? DEFAULT_PRESENTMENT_CURRENCY;
}

/**
 * GET /offer-comparison — the eligible offers for one variant or product,
 * ranked, labelled and explained.
 *
 * The response carries the policy version, the currency, every captured rate,
 * every offer's signals and labels, and the offers eligibility refused with
 * their reasons. That last part is deliberate: "why is this offer not here" is
 * a question the separation exists to be able to answer, and answering it from
 * a second request would answer it about a different moment.
 */
export async function offerComparisonHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      canonicalVariantId?: string;
      canonicalProductId?: string;
      currency?: CurrencyCode;
      intent?: OfferComparisonIntent;
      experience?: OfferComparisonExperience;
      market?: string;
      customerClasses?: OfferCustomerEligibility[];
      conditions?: ItemConditionKey[];
      conditionGroups?: ConditionGroup[];
      viewerLatitude?: number;
      viewerLongitude?: number;
      limit?: number;
    };

    const { comparison, offers } = await rankOfferComparison({
      ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
      ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
      comparisonCurrency: await resolveComparisonCurrency(req, query.currency),
      ...(query.intent ? { intent: query.intent } : {}),
      ...(query.experience ? { experience: query.experience } : {}),
      ...(query.market ? { market: query.market.toUpperCase() } : {}),
      ...(query.customerClasses ? { customerClasses: query.customerClasses } : {}),
      ...(query.conditions ? { conditionKeys: query.conditions } : {}),
      ...(query.conditionGroups ? { conditionGroups: query.conditionGroups } : {}),
      ...(query.viewerLatitude === undefined ? {} : { viewerLatitude: query.viewerLatitude }),
      ...(query.viewerLongitude === undefined ? {} : { viewerLongitude: query.viewerLongitude }),
      limit: Math.min(
        query.limit ?? config.pagination.defaultPageSize,
        config.pagination.maxPageSize,
      ),
    });

    // One `offer_impression` per SERVED offer, matching `/offers`' own rule so
    // the two surfaces' click-through denominators mean the same thing — and
    // each one naming the policy version that put it where it is.
    for (const ranked of comparison.offers) {
      const offer = offers.get(ranked.offerId);
      if (offer === undefined) continue;
      emitAnalyticsEvent(req, {
        eventType: 'offer_impression',
        entities: {
          offerId: offer.id,
          canonicalVariantId: offer.canonicalVariantId,
          ...(offer.merchantId === undefined ? {} : { merchantId: offer.merchantId }),
          ...(offer.storefrontId === undefined ? {} : { storefrontId: offer.storefrontId }),
        },
        rankingPolicyVersion: comparison.policy.version,
      });
    }

    sendSuccess(res, comparison);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to rank offers');
  }
}
