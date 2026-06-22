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
 * Encode a `(publishedAt, id)` tuple into an opaque, URL-safe base64 cursor.
 * The feed reads `(publishedAt, _id)` from the last item of a page to produce
 * the cursor for the next page.
 */
export function encodeCursor(publishedAt: Date, id: string): string {
  const payload = `${publishedAt.toISOString()}${CURSOR_SEPARATOR}${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** The decoded shape of a feed cursor. */
export interface DecodedCursor {
  /** The `publishedAt` boundary of the last item on the previous page. */
  publishedAt: Date;
  /** The `_id` boundary of the last item on the previous page. */
  id: string;
}

/**
 * Decode an opaque cursor produced by `encodeCursor`. Returns `null` for any
 * malformed input (bad base64, missing parts, invalid date) so callers can
 * treat a broken cursor as "no cursor" rather than throwing.
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

  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex >= decoded.length - 1) {
    return null;
  }

  const isoDate = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  const publishedAt = new Date(isoDate);

  if (Number.isNaN(publishedAt.getTime()) || id.length === 0) {
    return null;
  }

  return { publishedAt, id };
}
