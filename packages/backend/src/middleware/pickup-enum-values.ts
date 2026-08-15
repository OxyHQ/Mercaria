/**
 * The non-empty tuple `z.enum` needs, and the two bounds a publication's
 * freshness interval must fall inside — re-stated for the SCHEMA layer.
 *
 * `asEnumValues` exists in `db/schema/columns.ts` for the same reason and is
 * deliberately not imported from there: a request schema importing a drizzle
 * module would pull the whole schema barrel into the middleware layer, and
 * `columns.ts`'s own docblock is about what a COLUMN needs. What both share is
 * the shared-types tuple they narrow, which is the thing that must not drift.
 *
 * The bounds are re-exported from the schema rather than re-declared, so the
 * API's refusal and the database's CHECK cannot disagree about what a valid
 * interval is.
 */

export {
  MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS,
  MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS,
} from '../db/schema/pickup.js';

/**
 * A shared-types runtime list, narrowed to the NON-EMPTY tuple `z.enum` needs.
 *
 * Throws at module load on an empty list rather than casting: `z.enum([])`
 * types every value `never` and rejects every input, which is a schema that
 * refuses everything and says nothing about why.
 */
export function asEnumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('asEnumValues received an empty list; z.enum of nothing rejects every input.');
  }
  return [first, ...rest];
}
