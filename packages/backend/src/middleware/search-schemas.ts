/**
 * Request schemas for canonical search (#70).
 *
 * `.strict()`, and every value tuple comes from `@mercaria/shared-types` rather
 * than being retyped, so the schema cannot admit a value the domain refuses.
 *
 * ## What `.strict()` is doing here specifically
 *
 * The fields this schema does NOT have are the enforcement:
 *
 * - **No `boost`, `pin`, `promote`, `sponsored` or `sort` field.** Ordering is
 *   the relevance policy's, and a request able to name a weight would be a
 *   ranking surface a caller controls. `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS`
 *   states the prohibition as a value; this states it as an absence.
 * - **No `near`, `lat`, `lng` or `radius`.** #93 supplies no collectable
 *   inventory or pickup publication state, so a proximity filter here would
 *   accept a parameter and change nothing. The native listing search keeps its
 *   own `near` — that filter is a fact about a LISTING, which has coordinates,
 *   and not about a canonical product, which does not.
 * - **No raw price without a currency.** `price` is an object whose `currency`
 *   is required, so an amount cannot reach the service without the unit it is
 *   in — #70's "never compare raw money amounts across currencies" held by the
 *   shape rather than by a check.
 * - **No `includeStale`.** `GET /offers` has one because an operator
 *   investigating a lapsed offer needs to see it. A discovery surface has no
 *   such caller, and a parameter that could put an expired price on a search
 *   page is exactly #70 freshness rule 3.
 */

import { z } from 'zod';
import {
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  OFFER_KINDS,
  SEARCH_RESULT_KINDS,
  type ConditionGroup,
  type OfferAvailability,
  type OfferKind,
  type SearchResultKind,
} from '@mercaria/shared-types';
import { SEARCH_QUERY_MAX_LENGTH } from '../services/search/normalize.js';
import { SEARCH_PAGE_LIMIT_MAX } from '../services/search/canonical-search.service.js';

const RESULT_KIND_VALUES = SEARCH_RESULT_KINDS as readonly [SearchResultKind, ...SearchResultKind[]];
const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const AVAILABILITY_VALUES = OFFER_AVAILABILITY_STATES as readonly [
  OfferAvailability,
  ...OfferAvailability[],
];
const OFFER_KIND_VALUES = OFFER_KINDS as readonly [OfferKind, ...OfferKind[]];

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching `offers_country_check` rather than approximating it. */
const market = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);
/** The shape every currency column CHECK in this schema uses. */
const currency = z.string().trim().regex(/^[A-Za-z]{3,4}$/);

/** A comma-separated query value, as a browser and a fetch client both send it. */
function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

/** A comma-separated list of opaque ids. */
const idList = z
  .string()
  .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
  .pipe(z.array(entityId).min(1).max(50));

/**
 * One `#94` attribute constraint, as `key:value` or `key:min..max`.
 *
 * A compact wire form rather than repeated bracketed parameters, because the
 * filter is a LIST and every serialization of a list in a query string is a
 * convention — this one is stated once, parsed once, and refused when it does
 * not parse rather than silently ignored.
 *
 * A range and an exact value are mutually exclusive by construction: the two
 * spellings cannot both be present in one entry, so there is no precedence rule
 * to remember and no request that means two things.
 */
const attributeEntry = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .transform((raw, ctx) => {
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected `key:value` or `key:min..max`' });
      return z.NEVER;
    }
    const key = raw.slice(0, separator).trim().toLowerCase();
    const rest = raw.slice(separator + 1).trim();
    const range = rest.split('..');
    if (range.length === 2) {
      const min = range[0] === '' ? undefined : Number(range[0]);
      const max = range[1] === '' ? undefined : Number(range[1]);
      if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) {
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
  .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
  .pipe(z.array(attributeEntry).min(1).max(10));

/**
 * `GET /search`.
 *
 * `q` is REQUIRED and non-empty. A canonical search with no term is a browse,
 * and browse already exists — answering one here would make this surface a
 * second, unindexed catalogue listing, ordered by a relevance score computed
 * from nothing.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
    kinds: commaList(RESULT_KIND_VALUES).optional(),
    categories: idList.optional(),
    brandIds: idList.optional(),
    market: market.optional(),
    priceCurrency: currency.optional(),
    priceMin: z.coerce.number().int().nonnegative().optional(),
    priceMax: z.coerce.number().int().nonnegative().optional(),
    conditionGroups: commaList(CONDITION_GROUP_VALUES).optional(),
    availability: commaList(AVAILABILITY_VALUES).optional(),
    offerKinds: commaList(OFFER_KIND_VALUES).optional(),
    officialChannelOnly: z.enum(['true', 'false']).optional(),
    merchantIds: idList.optional(),
    attributes: attributeList.optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_LIMIT_MAX).optional(),
    cursor: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.priceMin === undefined && query.priceMax === undefined) ||
      query.priceCurrency !== undefined,
    {
      message: 'priceCurrency is required when priceMin or priceMax is given',
      path: ['priceCurrency'],
    },
  )
  .refine(
    (query) =>
      query.priceMin === undefined ||
      query.priceMax === undefined ||
      query.priceMin <= query.priceMax,
    { message: 'priceMin must not exceed priceMax', path: ['priceMin'] },
  );

/**
 * `POST /internal/search/explain` — one query's full pipeline trace.
 *
 * It takes the SAME fields as the public schema and adds nothing: an operator
 * surface able to ask a question the public one cannot is a second search with
 * its own behaviour, and the whole value of a trace is that it explains what a
 * shopper actually got.
 */
export const searchExplainBodySchema = searchQuerySchema;
