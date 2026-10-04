/**
 * What a `/public/v1` request may carry: path parameters and query strings, as
 * they arrive on the WIRE (strings), parsed into typed values.
 *
 * The backend validates `req.params` and `req.query` with these, and the SDK
 * runs the query it is about to send through the same schema, so a request the
 * server would refuse is refused before it leaves.
 *
 * - Every query schema is STRICT: an unknown parameter is refused rather than
 *   ignored, because a caller who misspells `inStock` must not receive an
 *   unfiltered page it reads as filtered. A repeated parameter (`?q=a&q=b`)
 *   arrives as an array and is refused too; no parameter is list-valued.
 * - Numbers and booleans are parsed from their EXACT spellings — `limit` is
 *   decimal digits, `inStock` is `true` or `false` — never through `z.coerce`,
 *   which would accept `1e1`, ` 5`, `yes` and the empty string.
 * - Defaults (`limit`, `sort`) are applied by the backend controller, not
 *   here, so the parsed value says what the caller SENT.
 */

import { z } from 'zod';
import { MercariaProductSortSchema } from './catalog';
import { MERCARIA_PUBLIC_PAGE_LIMIT_MAX, MercariaCursorSchema } from './pagination';

/** The longest free-text query the surface accepts. */
export const MERCARIA_PUBLIC_QUERY_MAX_LENGTH = 200;

/** A path parameter: one opaque id. A malformed one is a 404 from the read, never a 400. */
export const MercariaIdParamsSchema = z.strictObject({
  id: z.string().describe('The entity id. A malformed id answers 404, not 400.'),
});

/** An opaque entity id in a query filter. The read decides whether it exists. */
const filterId = z.string().trim().min(1).max(64);

const pageShape = {
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'must be a whole number')
    .transform((raw) => Number.parseInt(raw, 10))
    .pipe(z.number().int().min(1).max(MERCARIA_PUBLIC_PAGE_LIMIT_MAX))
    .optional()
    .describe(`Page size, 1–${MERCARIA_PUBLIC_PAGE_LIMIT_MAX}. Default 20.`),
  cursor: MercariaCursorSchema.optional().describe(
    'The previous page’s `nextCursor`, verbatim, with the same filters.',
  ),
};

const productListShape = {
  ...pageShape,
  q: z
    .string()
    .trim()
    .min(1)
    .max(MERCARIA_PUBLIC_QUERY_MAX_LENGTH)
    .optional()
    .describe(`Full-text query, 1–${MERCARIA_PUBLIC_QUERY_MAX_LENGTH} characters after trimming.`),
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
    .describe('`true` keeps products that can be bought now; `false` filters nothing.'),
  sort: MercariaProductSortSchema.optional().describe(
    'Ordering. Default `relevance` with `q`, `newest` without; `relevance` requires `q`.',
  ),
  locale: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .optional()
    .describe('A BCP 47 tag whose translations are ALSO searched. No effect without `q`.'),
};

/** `relevance` needs a query to be relevant to. */
function refusingRelevanceWithoutQuery<Shape extends typeof productListShape>(shape: Shape) {
  return z.strictObject(shape).superRefine((value, ctx) => {
    const { q, sort } = value as { q?: string; sort?: string };
    if (sort === 'relevance' && q === undefined) {
      ctx.addIssue({ code: 'custom', path: ['sort'], message: 'relevance requires q' });
    }
  });
}

/** `GET /products`. */
export const MercariaProductSearchQuerySchema = refusingRelevanceWithoutQuery({
  ...productListShape,
  storeId: filterId.optional().describe('Only this store’s products. A gone store answers 410.'),
  collectionId: filterId.optional().describe('Only this collection’s products. A gone collection answers 410.'),
});

/** `GET /stores/{id}/products`. */
export const MercariaStoreProductsQuerySchema = refusingRelevanceWithoutQuery(productListShape);

/** `GET /stores/{id}/collections` and `GET /collections/{id}/products`. */
export const MercariaPageQuerySchema = z.strictObject(pageShape);

/** `GET /stores/lookup`. */
export const MercariaStoreLookupQuerySchema = z.strictObject({
  handle: z.string().trim().min(1).max(100).describe('The store’s CURRENT handle.'),
});

/** Every other route takes no query at all. */
export const MercariaNoQuerySchema = z.strictObject({});
