/**
 * Request schemas for the brand and family PAGES (#72).
 *
 * `.strict()`, and every value tuple comes from `@mercaria/shared-types` rather
 * than being retyped, so a schema cannot accept a value the domain refuses.
 *
 * ## What the ABSENT fields enforce
 *
 * - **No `sort`, `order`, `boost`, `pin` or `promote`.** The ordering is the
 *   scope's own (`catalog_name`, or `release_desc` when every product in the
 *   scope carries a release date), and a request able to name one would let a
 *   caller pick the ordering that flatters a product. `CatalogBrowseOrdering` is
 *   reported in the RESPONSE, which is the direction that makes it explicable.
 * - **No `officialChannelOnly`.** #70's search has one; a BRAND page must not,
 *   because "show me only this brand's official channels" is what the page's own
 *   two lists already answer, and a filter spelling of it on the product grid
 *   would quietly become "these are the products the brand endorses".
 * - **No `merchantIds`.** A brand page is not a merchant storefront (#73 owns
 *   those), and a merchant filter on it is the first step to becoming one.
 * - **No `priceMin`/`priceMax`.** A price bound needs a currency, an FX context
 *   and an unconvertible-currency report to be honest about, all of which
 *   `GET /search` already carries. Adding a half version here would be a second
 *   price filter with different behaviour.
 * - **No free text on a correction.** See `services/catalog-pages/correction.service.ts`.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CATALOG_CORRECTION_FIELDS,
  CATALOG_CORRECTION_SUBJECTS,
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  type CatalogCorrectionField,
  type CatalogCorrectionSubject,
  type ConditionGroup,
  type CurrencyCode,
  type OfferAvailability,
} from '@mercaria/shared-types';
import { CATALOG_BROWSE_MAX_LIMIT } from '../services/catalog-pages/product-browse.service.js';

const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const AVAILABILITY_VALUES = OFFER_AVAILABILITY_STATES as readonly [
  OfferAvailability,
  ...OfferAvailability[],
];
const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const CORRECTION_FIELD_VALUES = CATALOG_CORRECTION_FIELDS as readonly [
  CatalogCorrectionField,
  ...CatalogCorrectionField[],
];
const CORRECTION_SUBJECT_VALUES = CATALOG_CORRECTION_SUBJECTS as readonly [
  CatalogCorrectionSubject,
  ...CatalogCorrectionSubject[],
];

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching `offers_country_check` rather than approximating it. */
const market = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);
/** A category SLUG, not an id: what a URL carries and what a shopper can read. */
const categorySlug = z.string().trim().min(1).max(128);

/** A comma-separated query value, as a browser and a fetch client both send it. */
function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

/** A comma-separated list of opaque values, bounded. */
function boundedList(item: z.ZodString, max: number) {
  return z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(item).min(1).max(max));
}

/**
 * One #94 attribute constraint, as `key:value` or `key:min..max`.
 *
 * The SAME wire form `GET /search` accepts, deliberately: a shopper who
 * narrowed a search by screen size and then opened the brand page must not have
 * to learn a second spelling, and two spellings of one filter is how the two
 * surfaces start disagreeing about what a constraint means.
 */
const attributeEntry = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .transform((raw, ctx) => {
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expected `key:value` or `key:min..max`',
      });
      return z.NEVER;
    }
    const key = raw.slice(0, separator).trim().toLowerCase();
    const rest = raw.slice(separator + 1).trim();
    const range = rest.split('..');
    if (range.length === 2) {
      const min = range[0] === '' ? undefined : Number(range[0]);
      const max = range[1] === '' ? undefined : Number(range[1]);
      if (
        (min !== undefined && !Number.isFinite(min)) ||
        (max !== undefined && !Number.isFinite(max))
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a range bound must be a number' });
        return z.NEVER;
      }
      if (min === undefined && max === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a range needs at least one bound' });
        return z.NEVER;
      }
      return {
        key,
        ...(min === undefined ? {} : { minNumber: min }),
        ...(max === undefined ? {} : { maxNumber: max }),
      };
    }
    return { key, value: rest.toLowerCase() };
  });

const attributeList = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(z.array(attributeEntry).min(1).max(10));

/** `GET /catalog-pages/brands/:handle` and `…/families/:handle`. */
export const catalogPageQuerySchema = z
  .object({
    market: market.optional(),
    /**
     * The currency a family page's price range is stated in.
     *
     * Optional, and the service supplies the deployment's presentment default
     * when it is absent — but the RESPONSE always names whichever was used, so
     * a range is never a number whose unit a reader has to assume.
     */
    currency: z.enum(CURRENCY_VALUES).optional(),
  })
  .strict();

/** `GET /catalog-pages/brands/:handle/products` and `…/families/:handle/products`. */
export const catalogBrowseQuerySchema = z
  .object({
    categories: boundedList(categorySlug, 20).optional(),
    families: boundedList(entityId, 20).optional(),
    conditionGroups: commaList(CONDITION_GROUP_VALUES).optional(),
    availability: commaList(AVAILABILITY_VALUES).optional(),
    market: market.optional(),
    attributes: attributeList.optional(),
    limit: z.coerce.number().int().min(1).max(CATALOG_BROWSE_MAX_LIMIT).optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/** `POST /catalog-pages/corrections` — a dispute, never an edit. */
export const catalogCorrectionSchema = z
  .object({
    subject: z.enum(CORRECTION_SUBJECT_VALUES),
    handle: z.string().trim().min(1).max(256),
    field: z.enum(CORRECTION_FIELD_VALUES),
  })
  .strict();
