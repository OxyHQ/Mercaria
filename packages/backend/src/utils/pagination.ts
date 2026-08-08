/**
 * Pagination helpers.
 *
 * Offset pagination (`parsePagination` / `buildPagination`) backs browse and
 * admin list endpoints via the shared `Pagination` contract. Cursor pagination
 * (`encodeCursor` / `decodeCursor`) backs the infinite home feed, encoding a
 * `(publishedAt, _id)` tuple so the feed can page deterministically over the
 * `{ status, publishedAt: -1, _id: -1 }` index.
 */

import type { Pagination } from '@mercaria/shared-types';
import { config } from '../config/index.js';

/** A query bag with possibly-present, possibly-array `page`/`limit` values. */
type RawPaginationQuery = {
  page?: unknown;
  limit?: unknown;
};

/** Coerce a raw query value (string | string[] | undefined) to a finite int. */
function toInt(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse and clamp offset pagination from a request query.
 * - `page` is 1-based and floored at 1.
 * - `limit` defaults to `config.pagination.defaultPageSize` and is clamped to
 *   `[1, config.pagination.maxPageSize]`.
 */
export function parsePagination(query: RawPaginationQuery): {
  page: number;
  limit: number;
} {
  const { defaultPageSize, maxPageSize } = config.pagination;

  const pageRaw = toInt(query.page) ?? 1;
  const page = Math.max(1, pageRaw);

  const limitRaw = toInt(query.limit) ?? defaultPageSize;
  const limit = Math.min(maxPageSize, Math.max(1, limitRaw));

  return { page, limit };
}

/** Build the `Pagination` metadata object from a page/limit/total. */
export function buildPagination(
  page: number,
  limit: number,
  total: number,
): Pagination {
  const pages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    pages,
    hasNextPage: page < pages,
    hasPreviousPage: page > 1,
  };
}

/** Field separator inside the decoded cursor payload. */
const CURSOR_SEPARATOR = '|';

/**
 * The cursor format version, and the reason there is one.
 *
 * The v1 format was `<iso>|<ObjectId>`, and its `publishedAt` was never NULL
 * because the Mongo path substituted `createdAt` when a listing had none. The
 * Postgres keyset orders by a NULLABLE `published_at`, so the tuple gained a
 * third state — and a v1 cursor read as a v2 one would resume from a boundary
 * that never existed, silently skipping or repeating a page.
 *
 * Bumping the version makes an old cursor UNREADABLE rather than
 * misinterpretable: {@link decodeCursor} returns `null`, and every caller
 * already treats `null` as "no cursor" and serves the first page. A client that
 * held a cursor across the cutover restarts its feed, which is the only
 * behaviour that cannot be wrong.
 */
const CURSOR_VERSION = 'v2';

/** Stands in for a NULL `publishedAt` inside the encoded tuple. */
const CURSOR_NULL_DATE = '-';

/**
 * Encode a `(publishedAt, id)` tuple into an opaque, URL-safe base64 cursor.
 * The feed reads the tuple from the last item of a page to produce the cursor
 * for the next page.
 *
 * `publishedAt` may be `null`: an unpublished listing sorts after every
 * published one, and it still has to be possible to page THROUGH that tail.
 */
export function encodeCursor(publishedAt: Date | null, id: string): string {
  const date = publishedAt ? publishedAt.toISOString() : CURSOR_NULL_DATE;
  const payload = [CURSOR_VERSION, date, id].join(CURSOR_SEPARATOR);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** The decoded shape of a feed cursor. */
export interface DecodedCursor {
  /** The `publishedAt` boundary of the last item on the previous page. */
  publishedAt: Date | null;
  /** The id boundary of the last item on the previous page. */
  id: string;
}

/**
 * Decode an opaque cursor produced by `encodeCursor`. Returns `null` for any
 * input this version cannot read — bad base64, a missing or unknown version, the
 * wrong number of parts, an invalid date — so callers treat it as "no cursor"
 * rather than throwing. A v1 cursor lands here by design; see
 * {@link CURSOR_VERSION}.
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length !== 3) {
    return null;
  }

  const [version, isoDate, id] = parts;
  if (version !== CURSOR_VERSION || id.length === 0) {
    return null;
  }

  if (isoDate === CURSOR_NULL_DATE) {
    return { publishedAt: null, id };
  }

  const publishedAt = new Date(isoDate);
  if (Number.isNaN(publishedAt.getTime())) {
    return null;
  }

  return { publishedAt, id };
}
