/**
 * Request schemas for the translation desk (#367 merge-order step 10).
 *
 * Every schema is `.strict()`. An undeclared key is REFUSED rather than
 * stripped, which is this repository's standing decision everywhere a surface
 * takes input — a stripped key is a caller believing it asked for something it
 * did not get.
 *
 * The locale parameters are `z.enum(SUPPORTED_LOCALES)` — the STRICT form
 * `reviewLocalizationSchema` uses, not the permissive BCP 47 regex the public
 * taxonomy reads use. The two are right for different jobs: a shopper's
 * `?locale=` is a REQUEST that falls through a chain, so an unauthored tag
 * legitimately resolves to something else; a desk read names a locale Mercaria
 * AUTHORS in, and a tag outside the tuple is a typo whose honest answer is 400
 * rather than an empty report that reads as "nothing outstanding".
 */

import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@mercaria/shared-types';

/** `z.enum` wants a non-empty tuple; the shared constants are readonly arrays. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  return values as unknown as readonly [T, ...T[]];
}

/**
 * Which locales a completeness report covers.
 *
 * Defaults to `launch`. The desk's standing question is "what is a shopper
 * reading in a market we opened", and a report over all forty supported locales
 * is dominated by locales nobody ships an app in — which buries the eleven that
 * matter under twenty-nine that do not.
 */
export const localizationCompletenessQuerySchema = z
  .object({
    scope: z.enum(['launch', 'all']).default('launch'),
  })
  .strict();

/**
 * One entity's review, in one locale.
 *
 * `locale` is REQUIRED and has no default. A default would make the commonest
 * mistake — forgetting to pass one — return a confident report about a locale
 * the caller did not choose, and for a review screen that is the difference
 * between approving Spanish and approving something else.
 */
export const localizationReviewQuerySchema = z
  .object({
    locale: z.enum(tuple(SUPPORTED_LOCALES)),
  })
  .strict();

/*
 * There is deliberately no params schema here.
 *
 * `validate.ts` exports `validateBody`, `validateQuery` and `validateId` and no
 * params validator, and the review route is the only surface in the repository
 * that wants one. Adding a generic `validateParams` to shared middleware that
 * several other lanes are editing, for one call site, is the worse trade — so
 * the `:domain` membership test runs at the top of
 * `localizationReviewHandler`, before any read, which is the property that
 * actually matters. `validateId('entityId')` covers the other param.
 */
