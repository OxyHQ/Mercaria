/**
 * The search keyset cursor (#70 "Pagination").
 *
 * ## Keyset over a MERGED, SCORED set — and why that is still a keyset
 *
 * A search page is not one SQL ordering. Five entity kinds are retrieved by
 * seven stages, scored by `relevance.ts` and merged, so there is no single
 * index whose order a SQL cursor could resume from. What makes this a keyset
 * rather than an offset is the property that matters: the cursor carries the
 * ORDERING TUPLE of the last candidate CONSIDERED — `(score, kind, id)` — and
 * the next page is everything strictly after it in that total order. Rows
 * appearing or vanishing between pages shift no boundary, which is exactly what
 * an OFFSET cannot promise and what #70 asks for.
 *
 * "Considered" rather than "served" is deliberate and load-bearing: an
 * offer-side filter (a price bound, an availability, an official channel) can
 * drop a candidate AFTER it has been scored, and a cursor pointing at the last
 * SERVED row would then re-consider — and re-drop — every candidate between it
 * and where the page actually stopped, on every subsequent page, forever.
 *
 * The tuple is TOTAL: `id` is unique within a kind and the kind index breaks
 * ties across kinds, so no two rows compare equal and the cursor can never loop
 * or skip on a tie. Scores tie constantly — twenty brands all matched by exact
 * name — which is precisely why the id is in the tuple and not decoration.
 *
 * ## The fingerprint, and why a foreign cursor is UNREADABLE rather than wrong
 *
 * A cursor is only meaningful against the query that produced it: applying one
 * from `iphone` to a search for `laptop` would resume from a score boundary
 * that means nothing there and silently drop the first page of real results.
 * So the cursor carries a digest of the normalized query, its filters and its
 * kinds, and {@link decodeSearchCursor} returns `null` when it does not match —
 * which every caller already treats as "no cursor" and answers with the first
 * page. The `utils/pagination.ts` version rule, applied to a second dimension:
 * unreadable beats misinterpretable.
 *
 * ## Depth, and why it is in the cursor
 *
 * Candidate generation is BOUNDED per stage, so a naive deep page would ask for
 * the same bounded set and find nothing after the cursor — the tail would
 * simply stop, silently. The cursor therefore carries how many rows have
 * already been served, and the retrieval bound grows with it up to
 * {@link SEARCH_MAX_DEPTH}. Past that ceiling the response says `truncated`
 * instead of pretending the tail ended.
 */

import { createHash } from 'node:crypto';
import { SEARCH_RESULT_KINDS } from '@mercaria/shared-types';
import type { SearchFilters, SearchResultKind } from '@mercaria/shared-types';

/** Cursor format version. Bumping it makes every older cursor unreadable. */
const CURSOR_VERSION = 'sc1';

const CURSOR_SEPARATOR = '|';

/**
 * How deep this surface will page before it stops.
 *
 * A ceiling rather than an unbounded walk, because retrieval widens with depth
 * and an unbounded widening is a sequential scan of the canonical catalogue
 * reached by adding `&cursor=` enough times. Five hundred rows is far past any
 * page a person reads and far short of anything expensive; a caller who needs
 * the whole matching set wants an export, not a search.
 */
export const SEARCH_MAX_DEPTH = 500;

/**
 * The score is carried as an INTEGER of micro-units.
 *
 * A float round-tripped through a decimal string is not guaranteed to compare
 * identically to the one the scorer produced, and a boundary that compares by a
 * hair in the wrong direction repeats or drops exactly one row per page — the
 * quietest possible pagination bug. Comparing integers removes the question.
 */
const SCORE_SCALE = 1_000_000;

/** The ordering tuple of one result. */
export interface SearchCursorPosition {
  readonly score: number;
  readonly kind: SearchResultKind;
  readonly id: string;
}

/** A decoded cursor: where to resume, and how far in we already are. */
export interface DecodedSearchCursor extends SearchCursorPosition {
  /** How many rows preceded this position across every earlier page. */
  readonly depth: number;
}

/**
 * The digest a cursor is bound to.
 *
 * Keys are sorted and every array is sorted before hashing, so two requests
 * that differ only in the order they listed their brand ids share a cursor —
 * they are the same query, and treating them as different would invalidate a
 * cursor for a reason a client cannot see. `JSON.stringify` of a hand-built,
 * key-ordered object rather than of the request bag: an unsorted bag makes the
 * digest depend on property insertion order, which is not something a wire
 * format guarantees.
 */
export function searchQueryFingerprint(input: {
  normalized: string;
  kinds: readonly SearchResultKind[];
  filters: SearchFilters;
}): string {
  const filters = input.filters;
  const sorted = (values: readonly string[] | undefined): readonly string[] =>
    values === undefined ? [] : [...values].sort();

  const canonical = JSON.stringify([
    input.normalized,
    [...input.kinds].sort(),
    sorted(filters.categorySlugs),
    sorted(filters.brandIds),
    filters.market ?? '',
    filters.price === undefined
      ? ''
      : [filters.price.currency, filters.price.minMinor ?? '', filters.price.maxMinor ?? ''],
    sorted(filters.conditionGroups),
    sorted(filters.availability),
    sorted(filters.offerKinds),
    filters.officialChannelOnly === true ? 1 : 0,
    sorted(filters.merchantIds),
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

/** Encode the position after which the next page starts. */
export function encodeSearchCursor(
  fingerprint: string,
  position: SearchCursorPosition,
  depth: number,
): string {
  const payload = [
    CURSOR_VERSION,
    fingerprint,
    String(depth),
    String(Math.round(position.score * SCORE_SCALE)),
    position.kind,
    position.id,
  ].join(CURSOR_SEPARATOR);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or answer `null` for anything this version cannot read.
 *
 * Every rejection path returns `null` rather than throwing, and they are
 * deliberately indistinguishable from each other: bad base64, the wrong
 * version, a foreign fingerprint, an unknown kind and a malformed number all
 * mean the same thing to the caller — serve the first page.
 */
export function decodeSearchCursor(
  cursor: string,
  fingerprint: string,
): DecodedSearchCursor | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length !== 6) return null;
  const [version, boundFingerprint, rawDepth, rawScore, rawKind, id] = parts;
  if (version !== CURSOR_VERSION) return null;
  if (boundFingerprint !== fingerprint) return null;
  if (id.length === 0) return null;

  const kind = SEARCH_RESULT_KINDS.find((candidate) => candidate === rawKind);
  if (kind === undefined) return null;

  const depth = Number.parseInt(rawDepth, 10);
  const score = Number.parseInt(rawScore, 10);
  if (!Number.isFinite(depth) || depth < 0) return null;
  if (!Number.isFinite(score)) return null;

  return { depth, score: score / SCORE_SCALE, kind, id };
}

/**
 * The total order results are served in: score DESC, then kind, then id.
 *
 * Kind order is `SEARCH_RESULT_KINDS`' own — product first, because a shopping
 * query almost always means a product and a brand result that outranked it on a
 * tie would read as a mistake. It is a TIEBREAK and never a boost: a brand
 * scoring higher than a product still comes first.
 */
export function compareSearchPositions(
  left: SearchCursorPosition,
  right: SearchCursorPosition,
): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftKind = SEARCH_RESULT_KINDS.indexOf(left.kind);
  const rightKind = SEARCH_RESULT_KINDS.indexOf(right.kind);
  if (leftKind !== rightKind) return leftKind - rightKind;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Whether a position falls strictly after the cursor in the serving order.
 *
 * The comparison is on the ROUNDED score, matching what the cursor stores, so a
 * row whose score differs from the boundary's only below the micro-unit
 * resolution is ordered by kind and id instead — deterministically, and the
 * same way on the page that produced the cursor and the page that consumes it.
 */
export function isAfterSearchCursor(
  position: SearchCursorPosition,
  cursor: SearchCursorPosition,
): boolean {
  const rounded = {
    score: Math.round(position.score * SCORE_SCALE) / SCORE_SCALE,
    kind: position.kind,
    id: position.id,
  };
  return compareSearchPositions(rounded, cursor) > 0;
}
