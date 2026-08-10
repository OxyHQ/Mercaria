/**
 * Request schemas for the merchant page and its catalogue browse (#73).
 *
 * Its own file, following `commerce-graph-schemas.ts` and `payments-schemas.ts`.
 * Every schema is `.strict()`, which is the rule that makes "this surface
 * cannot be asked X" checkable at the schema rather than a habit at every
 * handler — and here the X that matters is a RANKING parameter. There is no
 * `sort`, no `boost`, no `order` and no `pin` key, so the only order a merchant
 * page can be asked for is the one it serves (#74 owns ranking).
 *
 * Value tuples come from `@mercaria/shared-types`, never retyped: a hand-copied
 * condition or availability list here could accept a value the database CHECK
 * then refuses, and the refusal would arrive as a 500.
 */

import { z } from 'zod';
import {
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  type ConditionGroup,
  type OfferAvailability,
} from '@mercaria/shared-types';

const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const AVAILABILITY_VALUES = OFFER_AVAILABILITY_STATES as readonly [
  OfferAvailability,
  ...OfferAvailability[],
];

/**
 * A repeated query parameter, which Express gives as a string OR an array.
 *
 * Written once rather than per field because a facet UI legitimately sends
 * `?conditionGroups=new&conditionGroups=refurbished`, and a schema that
 * accepted only the array form would 400 the single-selection case — which is
 * the commonest one.
 */
function repeatable<T extends string>(values: readonly [T, ...T[]]): z.ZodType<T[] | undefined> {
  return z
    .union([z.enum(values), z.array(z.enum(values))])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ) as z.ZodType<T[] | undefined>;
}

/**
 * `GET /merchants/:idOrSlug/catalog` and `/offers`.
 *
 * `sellers=all` is the marketplace lens and is refused by the service for a
 * channel this merchant does not operate — a service decision rather than a
 * schema one, because it depends on a row.
 */
export const merchantCatalogQuerySchema = z
  .object({
    storefrontId: z.string().trim().min(1).max(64).optional(),
    sellers: z.enum(['this_merchant', 'all']).optional(),
    categoryId: z.string().trim().min(1).max(64).optional(),
    brandId: z.string().trim().min(1).max(64).optional(),
    /** ISO 3166-1 alpha-2. Admits market-less offers, which are sold everywhere. */
    market: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .optional(),
    conditionGroups: repeatable(CONDITION_GROUP_VALUES),
    availability: repeatable(AVAILABILITY_VALUES),
    limit: z.coerce.number().int().min(1).max(48).optional(),
    cursor: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((query) => query.sellers !== 'all' || query.storefrontId !== undefined, {
    message: 'sellers=all names a channel: pass storefrontId',
  });
