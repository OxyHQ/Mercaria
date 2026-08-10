/**
 * The brand/family browse keyset cursor (#72 product-browse rule 6).
 *
 * A real SQL keyset, unlike #70's — one scope, one ordering, one index — so the
 * cursor carries the ORDERING TUPLE the statement resumes from rather than a
 * score. What it borrows from #70 is the property that matters: a cursor is
 * BOUND to the scope, the ordering and the filters it was minted under, and a
 * cursor that does not match is UNREADABLE (`null` ⇒ serve the first page)
 * rather than misapplied.
 *
 * That binding is not decoration. The two orderings this domain serves sort by
 * different columns in different directions, so resuming a `release_desc` walk
 * from a `catalog_name` boundary would skip or repeat an arbitrary run of rows
 * and report neither — the quietest pagination bug there is. Refusing to read
 * the cursor at all costs one duplicated first page and cannot lose a row.
 *
 * The tuple is TOTAL in both orderings: `(name, id)` under `catalog_name`, and
 * `(released_at, name, id)` under `release_desc`. `id` is the tiebreak and
 * never the sort key — see `db/catalogPages/catalogPageRepository.ts` for why
 * ordering a catalogue by a uuid v7 is ordering it by ingestion time.
 */

import { createHash } from 'node:crypto';
import { CATALOG_BROWSE_ORDERINGS } from '@mercaria/shared-types';
import type { CatalogBrowseFilters, CatalogBrowseOrdering } from '@mercaria/shared-types';
import type {
  CatalogBrowseCursorPosition,
  CatalogBrowseScope,
} from '../../db/catalogPages/catalogPageRepository.js';

/** Cursor format version. Bumping it makes every older cursor unreadable. */
const CURSOR_VERSION = 'cp1';

const CURSOR_SEPARATOR = '';

/**
 * The digest a cursor is bound to.
 *
 * Every array is sorted before hashing, so two requests differing only in the
 * order they listed their category slugs share a cursor — they are the same
 * browse, and invalidating one for a reason the client cannot see would look
 * like the tail of the list simply ending.
 */
export function catalogBrowseFingerprint(input: {
  scope: CatalogBrowseScope;
  ordering: CatalogBrowseOrdering;
  filters: CatalogBrowseFilters;
}): string {
  const filters = input.filters;
  const sorted = (values: readonly string[] | undefined): readonly string[] =>
    values === undefined ? [] : [...values].sort();

  const canonical = JSON.stringify([
    input.scope.kind,
    input.scope.kind === 'brand' ? input.scope.brandId : input.scope.familyId,
    input.ordering,
    sorted(filters.categorySlugs),
    sorted(filters.familyIds),
    sorted(filters.conditionGroups),
    sorted(filters.availability),
    filters.market ?? '',
    (filters.attributes ?? [])
      .map((attribute) => [
        attribute.key,
        attribute.value ?? '',
        attribute.minNumber ?? '',
        attribute.maxNumber ?? '',
      ])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Encode the position after which the next page starts.
 *
 * The name is carried verbatim, which is why the separator is the ASCII UNIT
 * SEPARATOR rather than a printable character: a product legitimately called
 * `Model | Pro` would otherwise split the payload and produce a cursor that
 * decodes to the wrong number of fields — unreadable, so the failure is safe,
 * but it would make deep paging impossible for exactly the products whose names
 * contain punctuation.
 */
export function encodeCatalogBrowseCursor(
  fingerprint: string,
  position: CatalogBrowseCursorPosition,
): string {
  const payload = [
    CURSOR_VERSION,
    fingerprint,
    position.releasedAt ?? '',
    position.id,
    position.name,
  ].join(CURSOR_SEPARATOR);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or answer `null` for anything this version cannot read.
 *
 * Every rejection path returns `null` and they are deliberately
 * indistinguishable: bad base64, the wrong version, a foreign fingerprint and a
 * `release_desc` cursor with no release instant all mean "serve the first page".
 */
export function decodeCatalogBrowseCursor(
  cursor: string,
  fingerprint: string,
  ordering: CatalogBrowseOrdering,
): CatalogBrowseCursorPosition | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length < 5) return null;
  const [version, boundFingerprint, releasedAt, id] = parts;
  // The name is carried LAST and rejoined from the tail, so a name that somehow
  // contains the separator byte decodes intact instead of making deep paging
  // impossible for exactly that one product.
  const name = parts.slice(4).join(CURSOR_SEPARATOR);
  if (version !== CURSOR_VERSION) return null;
  if (boundFingerprint !== fingerprint) return null;
  if (id.length === 0 || name.length === 0) return null;

  if (ordering === 'release_desc') {
    if (releasedAt.length === 0) return null;
    if (Number.isNaN(Date.parse(releasedAt))) return null;
    return { name, id, releasedAt };
  }
  return { name, id };
}

/** Whether a wire value names an ordering this surface serves. */
export function asCatalogBrowseOrdering(value: unknown): CatalogBrowseOrdering | null {
  return (CATALOG_BROWSE_ORDERINGS as readonly string[]).includes(value as string)
    ? (value as CatalogBrowseOrdering)
    : null;
}
