/**
 * Request schemas for the public integration surface (#1017, `/public/v1`).
 *
 * `.strict()` on every one, and every closed value set read from
 * `@mercaria/shared-types` `public-api.ts`, so the schema cannot admit a value
 * the contract does not name. An unknown query parameter is a 400 rather than an
 * ignored one: a foreign application that misspells `inStock` must not receive
 * an unfiltered page it reads as filtered.
 *
 * Numbers and booleans are parsed from their exact spellings — `limit` is
 * decimal digits and `inStock` is `true` or `false` — rather than through
 * `z.coerce`, which would accept `1e1`, ` 5`, `yes` and an empty string, and
 * turn each into a value the caller did not send.
 *
 * A repeated parameter (`?q=a&q=b`) arrives from Express as an array and is
 * refused by every schema here; the contract has no list-valued query.
 */

import { z } from 'zod';
import {
  MERCARIA_PRODUCT_SORTS,
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  type MercariaProductSort,
} from '@mercaria/shared-types';

const SORT_VALUES = MERCARIA_PRODUCT_SORTS as readonly [MercariaProductSort, ...MercariaProductSort[]];

/** The longest free-text query the surface accepts. */
export const PUBLIC_QUERY_MAX_LENGTH = 200;

/** An opaque entity id in a query filter. Shape is decided by the read, which 404s. */
const filterId = z.string().trim().min(1).max(64);

const limit = z
  .string()
  .regex(/^\d{1,3}$/u, 'limit must be a whole number')
  .transform((raw) => Number.parseInt(raw, 10))
  .pipe(z.number().int().min(1).max(MERCARIA_PUBLIC_PAGE_LIMIT_MAX))
  .optional();

const cursor = z.string().min(1).max(512).optional();

const pageShape = { limit, cursor };

const productListShape = {
  ...pageShape,
  q: z.string().trim().min(1).max(PUBLIC_QUERY_MAX_LENGTH).optional(),
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sort: z.enum(SORT_VALUES).optional(),
  /**
   * Which locale to ALSO search in, beside the seller's base text — the
   * `GET /listings` parameter, shape-checked the same way (a tag Mercaria has no
   * translations for is not an error a caller can act on). No effect without `q`.
   */
  locale: z.string().trim().min(2).max(35).optional(),
};

/**
 * `relevance` needs a query; with none it is a 400. The DEFAULT sort is applied
 * by the controller, not here — see `productListParams` there for why.
 */
function refusingRelevanceWithoutQuery<T extends { q?: string; sort?: MercariaProductSort }>(
  schema: z.ZodType<T>,
) {
  return schema.superRefine((value, ctx) => {
    if (value.sort === 'relevance' && value.q === undefined) {
      ctx.addIssue({ code: 'custom', path: ['sort'], message: 'sort=relevance requires q' });
    }
  });
}

/** `GET /public/v1/products`. */
export const publicProductSearchQuerySchema = refusingRelevanceWithoutQuery(
  z
    .object({
      ...productListShape,
      storeId: filterId.optional(),
      collectionId: filterId.optional(),
    })
    .strict(),
);

/** `GET /public/v1/stores/:id/products`. */
export const publicStoreProductsQuerySchema = refusingRelevanceWithoutQuery(
  z.object(productListShape).strict(),
);

/** `GET /public/v1/stores/:id/collections` and `/collections/:id/products`. */
export const publicPageQuerySchema = z.object(pageShape).strict();

/** `GET /public/v1/stores/lookup`. */
export const publicStoreLookupQuerySchema = z
  .object({ handle: z.string().trim().min(1).max(100) })
  .strict();

/** Every other public route takes no query at all. */
export const publicNoQuerySchema = z.object({}).strict();
