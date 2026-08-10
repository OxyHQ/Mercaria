/**
 * The canonical product page controller (THIN) — `GET /product-page/:idOrSlug`
 * (#71).
 *
 * ## Why this handler owns its rollout gate instead of `requireCanonicalReads`
 *
 * The #70 reasoning, verbatim, because it is the same lever: `shadow` means
 * COMPUTE BOTH ANSWERS AND COMPARE THEM (ADR 0002 D24 phase 3), and a
 * middleware that returns before the handler runs can never compute anything.
 * `services/backfill/read-mode.ts` names this page as the second surface that
 * would do it. The visible behaviour is identical to every other gated
 * canonical route — `off` and `shadow` are both a 404, never a 403 — so the
 * divergence is entirely behind the 404.
 *
 * The COHORT half of the lever is checked here too, and this is the first
 * handler that does. `read-mode.ts` splits it deliberately: the middleware
 * cannot answer a cohort question because it has not loaded the object, so a
 * handler serving one specific canonical row asks afterwards, with the row in
 * hand.
 *
 * ## Analytics: what this emits, and what it deliberately does not
 *
 * `product_page_view` after the 404 guard — the `listings.controller.ts` rule,
 * so a view of something that does not exist cannot inflate the denominator of
 * two metrics — and one `offer_impression` per SERVED offer carrying the
 * ranking policy version, exactly as `offer-comparison.controller.ts` does.
 *
 * It does NOT emit `variant_selected`, `offer_expanded`, `offer_selected`,
 * `external_outbound_click`, `save_action`, `alert_action` or
 * `sell_yours_entry`. Every one of those is a fact only a browser knows — a
 * control was pressed, a row was expanded, somebody navigated away — and the
 * storefront has no analytics client. Deriving them server-side would be
 * fabrication: a variant-scoped READ is a deep link as often as it is a
 * selection, and counting one as the other makes `variant_selected` a number
 * nobody can act on. They belong to #111 with #107's and #109's client facts,
 * and `services/analytics/seams.ts` carries the contract.
 */

import type { Request, Response } from 'express';
import type {
  CurrencyCode,
  OfferComparisonExperience,
  OfferComparisonIntent,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import { countActiveNativeListingsForCanonicalVariants } from '../db/productPage/productPageRepository.js';
import { canonicalReadPermitted, resolveOfferComparisonMode } from '../services/backfill/read-mode.js';
import { readCanonicalProductPage } from '../services/product-page/product-page.service.js';
import { recordProductPageShadow } from '../services/product-page/shadow.js';
import {
  DEFAULT_PRESENTMENT_CURRENCY,
  resolvePresentmentCurrency,
} from '../services/user-preference.service.js';
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * The currency this page's comparison is expressed in.
 *
 * `offer-comparison.controller.ts`'s rule, and it must stay the same rule: a
 * signed-in buyer's STORED preference is authoritative and `?currency=` is
 * ignored for them, because a preference they set is a decision and a link
 * somebody sent them is not. Two surfaces answering that differently would show
 * one shopper two currencies for one product.
 */
async function resolveComparisonCurrency(
  req: Request,
  requested: CurrencyCode | undefined,
): Promise<CurrencyCode> {
  const oxyUserId = req.user?.id;
  if (oxyUserId) return resolvePresentmentCurrency(oxyUserId);
  return requested ?? DEFAULT_PRESENTMENT_CURRENCY;
}

/** `GET /product-page/:idOrSlug` — one product, and every eligible way to get it. */
export async function canonicalProductPageHandler(req: Request, res: Response): Promise<void> {
  const mode = config.canonicalRollout.reads;
  const handle = routeParam(req, 'idOrSlug');
  const query = req.query as {
    canonicalVariantId?: string;
    currency?: CurrencyCode;
    market?: string;
    intent?: OfferComparisonIntent;
    experience?: OfferComparisonExperience;
    limit?: number;
  };

  try {
    if (mode === 'off') {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    // The offers half has its OWN lever, and it is read independently: a
    // deployment that withdrew price comparison during an incident still serves
    // product identity (#60 feature flags 2 and 3), and the withheld branch is
    // what stops that reading as a product nobody sells.
    const result = await readCanonicalProductPage({
      handle,
      ...(query.canonicalVariantId === undefined
        ? {}
        : { canonicalVariantId: query.canonicalVariantId }),
      ...(query.market === undefined ? {} : { market: query.market }),
      comparisonCurrency: await resolveComparisonCurrency(req, query.currency),
      ...(query.intent === undefined ? {} : { intent: query.intent }),
      ...(query.experience === undefined ? {} : { experience: query.experience }),
      limit: Math.min(
        query.limit ?? config.pagination.defaultPageSize,
        config.pagination.maxPageSize,
      ),
      offerComparisonPermitted: resolveOfferComparisonMode() === 'on',
    });

    if (result === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Product not found', 404);
      return;
    }

    // The cohort half, with the row in hand. A product carries a category, so
    // the subject is a real one — and a product with NO category is refused
    // while cohorts are non-empty, which is the fail-closed direction
    // `canonicalReadAllowedFor` documents: a canary that leaks the objects it
    // could not classify is not a canary.
    if (
      !canonicalReadPermitted(mode, {
        categoryId: result.page.product.categoryId ?? null,
      })
    ) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    if (mode === 'shadow') {
      // Compute BOTH answers, record how they differed, serve NEITHER. The
      // listing-first count comes from the native ATTACHMENTS rather than from
      // the offers this page just read — see the repository's docblock for why
      // measuring one table twice would be a check that cannot fail.
      const listingCount = await countActiveNativeListingsForCanonicalVariants(
        getDb(),
        result.page.variants.map((variant) => variant.id),
      );
      recordProductPageShadow(result.servedOffers.size, listingCount);
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    emitAnalyticsEvent(req, {
      eventType: 'product_page_view',
      entities: {
        canonicalProductId: result.page.product.id,
        ...(query.canonicalVariantId === undefined
          ? {}
          : { canonicalVariantId: query.canonicalVariantId }),
      },
    });

    // One impression per SERVED offer, matching `/offer-comparison`'s rule so
    // the two surfaces' click-through denominators mean the same thing, and
    // each naming the policy version that put it where it is.
    const offers = result.page.offers;
    if (offers.available === true) {
      for (const row of offers.rows) {
        emitAnalyticsEvent(req, {
          eventType: 'offer_impression',
          entities: {
            offerId: row.offer.id,
            canonicalProductId: result.page.product.id,
            canonicalVariantId: row.offer.canonicalVariantId,
            ...(row.offer.merchantId === undefined ? {} : { merchantId: row.offer.merchantId }),
            ...(row.offer.storefrontId === undefined
              ? {}
              : { storefrontId: row.offer.storefrontId }),
          },
          rankingPolicyVersion: offers.policy.version,
        });
      }
    }

    sendSuccess(res, result.page);
  } catch (error) {
    respondWithError(res, error, 'Failed to load the product page');
  }
}
