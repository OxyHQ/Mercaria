/**
 * Lists: one page shape, the page-size bounds, and the closed set of list
 * kinds a cursor can belong to.
 *
 * A list response is `{ items, nextCursor }` with no totals. `nextCursor` is
 * OPAQUE base64url — pass it back verbatim with the SAME filters for the next
 * page; `null` means there is none. Its contents are not a contract. The
 * backend binds every cursor to its list kind and filters through a
 * fingerprint (`services/public-api/cursor.ts`), so a cursor replayed on
 * another list or with other filters is `bad_request`, never a first page.
 */

import { z } from 'zod';
import { MercariaCollectionSchema, MercariaProductSummarySchema } from './catalog';

/** The largest page a public list read serves. */
export const MERCARIA_PUBLIC_PAGE_LIMIT_MAX = 50;
/** The page size a public list read applies when the caller names none. */
export const MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT = 20;
/** The deepest item a public list serves; the page reaching it carries `nextCursor: null`. */
export const MERCARIA_PUBLIC_LIST_MAX_OFFSET = 10_000;

/**
 * The lists a cursor can belong to — one per list route, named in the route
 * registry (`routes.ts`), so a new list is a new kind here and a new route
 * there.
 */
export const MERCARIA_PUBLIC_CURSOR_KINDS = [
  'products',
  'store-products',
  'store-collections',
  'collection-products',
] as const;
export type MercariaPublicCursorKind = (typeof MERCARIA_PUBLIC_CURSOR_KINDS)[number];

/** An opaque page cursor. */
export const MercariaCursorSchema = z.string().min(1).max(512).describe('An opaque page cursor.');

/** The page shape around any item schema. */
export function mercariaPageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: MercariaCursorSchema.nullable().describe('The next page’s cursor, or null on the last page.'),
  });
}

/** The page shape with its items left open, from which {@link MercariaPage} takes every other key. */
type PageEnvelope = z.infer<ReturnType<typeof mercariaPageSchema<z.ZodUnknown>>>;

/**
 * One page of a public list — the type of every {@link mercariaPageSchema},
 * for any item type. Mapped over the inferred page rather than spelled out, so
 * it keeps each key's optionality exactly as `z.infer` decides it: a program
 * compiled without `strictNullChecks` (the backend's) infers every key
 * optional, and a hand-written `nextCursor: string | null` would then disagree
 * with the schema it describes.
 */
export type MercariaPage<Item> = { [Key in keyof PageEnvelope]: Key extends 'items' ? Item[] : PageEnvelope[Key] };

export const MercariaProductSummaryPageSchema = mercariaPageSchema(MercariaProductSummarySchema);
export const MercariaCollectionPageSchema = mercariaPageSchema(MercariaCollectionSchema);
