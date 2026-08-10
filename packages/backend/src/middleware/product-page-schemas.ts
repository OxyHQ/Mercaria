/**
 * The request schema for the canonical product page (#71).
 *
 * `.strict()`, and every value tuple comes from `@mercaria/shared-types`.
 *
 * What the shape deliberately CANNOT carry is the point. There is no `score`,
 * `rank`, `label`, `weight`, `boost` or `policyVersion` — #74 owns the ordering
 * and a shopper who could name a version could shop for the ordering that
 * suited them. There is no `sort` either: a page-level sort parameter would be
 * a second ordering beside the intent, and the two would disagree the first
 * time anybody set both. And there is no `offerIds` or `merchantId` filter — a
 * page that could be asked for one seller's offers is a page that can be asked
 * to hide the others.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  OFFER_COMPARISON_EXPERIENCES,
  OFFER_COMPARISON_INTENTS,
  type CurrencyCode,
  type OfferComparisonExperience,
  type OfferComparisonIntent,
} from '@mercaria/shared-types';

function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

/**
 * `GET /product-page/:idOrSlug`.
 *
 * `canonicalVariantId` is what makes #71 acceptance 4 structural: with it the
 * comparison is scoped to one configuration and cannot contain another's offer,
 * rather than being filtered afterwards by whoever remembers to.
 */
export const productPageQuerySchema = z
  .object({
    canonicalVariantId: z.string().trim().min(1).max(64).optional(),
    currency: z.enum(tuple(ALL_CURRENCY_CODES as readonly CurrencyCode[])).optional(),
    market: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).optional(),
    intent: z.enum(tuple(OFFER_COMPARISON_INTENTS as readonly OfferComparisonIntent[])).optional(),
    experience: z
      .enum(tuple(OFFER_COMPARISON_EXPERIENCES as readonly OfferComparisonExperience[]))
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
