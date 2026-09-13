/**
 * The public integration surface's page cursor (#1017).
 *
 * The contract says a cursor is OPAQUE (`MercariaPage.nextCursor`): its contents
 * are not a promise, and a consumer passes it back verbatim. What it carries
 * today is a small versioned JSON payload, base64url-encoded:
 *
 * ```
 * { "v": 1, "k": <list kind>, "f": <fingerprint>, "o": <offset> }
 * ```
 *
 * ## Why an offset, and what that costs
 *
 * Every list here resumes an ordering the existing reads already define —
 * newest-first, price, a collection's own manual order — and none of those is a
 * single index a keyset could resume from without a second, parallel ordering
 * implementation to keep in step. An offset over a TOTAL order (every ordering
 * here ends in `id`) is deterministic for an unchanging catalogue: no duplicates
 * and no gaps. Under concurrent writes a product published or withdrawn between
 * two reads shifts the boundary by one, which `docs/public-api.md` states.
 *
 * ## Why a foreign cursor is a 400 rather than a first page
 *
 * The fingerprint is a digest of the list KIND, its scope (store or collection
 * id) and its normalized filters and sort. A cursor minted by another list, or
 * by the same list under different filters, would resume from an offset that
 * means nothing there — so it is refused as `VALIDATION_ERROR`. The page SIZE is
 * deliberately NOT in the fingerprint: the offset is an item count, so a caller
 * may change `limit` between pages and still get no duplicate and no gap.
 *
 * ## Depth
 *
 * OFFSET cost grows with depth, and an unbounded offset is a sequential scan
 * reachable by following `nextCursor` long enough. A list therefore ends at
 * {@link PUBLIC_CURSOR_MAX_OFFSET} items: the page reaching it is cut short and
 * carries `nextCursor: null`, and a cursor claiming a deeper offset is refused.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validationError } from '../../lib/errors/error-codes.js';

/** The deepest item a public list serves. Stated in `docs/public-api.md`. */
export const PUBLIC_CURSOR_MAX_OFFSET = 10_000;

/** The lists a cursor can belong to. */
export const PUBLIC_CURSOR_KINDS = [
  'products',
  'store-products',
  'store-collections',
  'collection-products',
] as const;
export type PublicCursorKind = (typeof PUBLIC_CURSOR_KINDS)[number];

const CURSOR_VERSION = 1;

/**
 * The scope and filters a cursor is only meaningful against. Values are
 * normalized by the caller (trimmed, defaulted); `undefined` members are
 * dropped, so an absent filter and an unsent one digest identically.
 */
export type PublicCursorScope = Readonly<Record<string, string | boolean | undefined>>;

/** A stable digest of a list kind plus its scope. Key order does not matter. */
export function publicCursorFingerprint(kind: PublicCursorKind, scope: PublicCursorScope): string {
  const entries = Object.entries(scope)
    .filter((entry): entry is [string, string | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([kind, entries]))
    .digest('base64url')
    .slice(0, 22);
}

const payloadSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    k: z.enum(PUBLIC_CURSOR_KINDS),
    f: z.string().min(1).max(64),
    o: z.number().int().min(1).max(PUBLIC_CURSOR_MAX_OFFSET - 1),
  })
  .strict();

/** Encode the cursor that resumes at `offset`. Deterministic for equal inputs. */
export function encodePublicCursor(
  kind: PublicCursorKind,
  fingerprint: string,
  offset: number,
): string {
  // Fixed key order, so equal inputs always produce the identical string.
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: kind, f: fingerprint, o: offset }),
    'utf8',
  ).toString('base64url');
}

/**
 * The offset a request's cursor resumes at — `0` with no cursor.
 *
 * @throws VALIDATION_ERROR for a cursor that is not base64url JSON of the
 * current version, belongs to another list kind, was minted under different
 * filters, or claims an offset outside `1..PUBLIC_CURSOR_MAX_OFFSET - 1`.
 */
export function resolvePublicCursorOffset(
  raw: string | undefined,
  kind: PublicCursorKind,
  fingerprint: string,
): number {
  if (raw === undefined) return 0;
  const refused = validationError('cursor: not a cursor this list issued');
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw refused;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw refused;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.k !== kind || parsed.data.f !== fingerprint) {
    throw refused;
  }
  return parsed.data.o;
}

/**
 * How many items a page starting at `offset` may serve: the requested `limit`,
 * cut so no page reaches past {@link PUBLIC_CURSOR_MAX_OFFSET}.
 */
export function clampPublicPageLimit(offset: number, limit: number): number {
  return Math.max(0, Math.min(limit, PUBLIC_CURSOR_MAX_OFFSET - offset));
}

/**
 * The cursor for the page after one that started at `offset` and served
 * `served` items, or `null` when there is none (or the depth ceiling is reached).
 */
export function nextPublicCursor(
  kind: PublicCursorKind,
  fingerprint: string,
  offset: number,
  served: number,
  hasMore: boolean,
): string | null {
  const next = offset + served;
  if (!hasMore || served === 0 || next >= PUBLIC_CURSOR_MAX_OFFSET) return null;
  return encodePublicCursor(kind, fingerprint, next);
}
