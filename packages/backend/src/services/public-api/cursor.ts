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
 * means nothing there — so it is refused as `bad_request`. The page SIZE is
 * deliberately NOT in the fingerprint: the offset is an item count, so a caller
 * may change `limit` between pages and still get no duplicate and no gap.
 *
 * ## A list that resumes a keyset of its own
 *
 * The catalogue search (`catalog-products`) is not an offset list: the
 * canonical search pipeline already pages by a keyset over its own relevance
 * order (`services/search/cursor.ts`), and an offset into it would re-run every
 * stage at every depth. Its public cursor therefore WRAPS that keyset cursor —
 * `{ "v": 1, "k", "f", "s": <search cursor> }` — under the same kind and
 * fingerprint binding, so a replay on another list or other filters is the
 * same `bad_request`. Depth there is bounded by the search's own ceiling.
 *
 * ## Depth
 *
 * OFFSET cost grows with depth, and an unbounded offset is a sequential scan
 * reachable by following `nextCursor` long enough. A list therefore ends at
 * `MERCARIA_PUBLIC_LIST_MAX_OFFSET` items: the page reaching it is cut short and
 * carries `nextCursor: null`, and a cursor claiming a deeper offset is refused.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MERCARIA_PUBLIC_CURSOR_KINDS,
  MERCARIA_PUBLIC_LIST_MAX_OFFSET,
  type MercariaPublicCursorKind,
} from '@mercaria/contracts';
import { badRequest } from './errors.js';

const CURSOR_VERSION = 1;

/**
 * The scope and filters a cursor is only meaningful against. Values are
 * normalized by the caller (trimmed, defaulted); `undefined` members are
 * dropped, so an absent filter and an unsent one digest identically.
 */
export type PublicCursorScope = Readonly<Record<string, string | boolean | undefined>>;

/** A stable digest of a list kind plus its scope. Key order does not matter. */
export function publicCursorFingerprint(
  kind: MercariaPublicCursorKind,
  scope: PublicCursorScope,
): string {
  const entries = Object.entries(scope)
    .filter((entry): entry is [string, string | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([kind, entries]))
    .digest('base64url')
    .slice(0, 22);
}

const bindingShape = {
  v: z.literal(CURSOR_VERSION),
  k: z.enum(MERCARIA_PUBLIC_CURSOR_KINDS),
  f: z.string().min(1).max(64),
};

const payloadSchema = z
  .object({
    ...bindingShape,
    o: z
      .number()
      .int()
      .min(1)
      .max(MERCARIA_PUBLIC_LIST_MAX_OFFSET - 1),
  })
  .strict();

/** A wrapped keyset cursor. Bounded so the encoded public cursor stays inside the contract's 512. */
const searchPayloadSchema = z
  .object({ ...bindingShape, s: z.string().regex(/^[A-Za-z0-9_-]{1,300}$/u) })
  .strict();

/** The decoded JSON of a cursor, or `undefined` when it is not base64url JSON at all. */
function decodePayload(raw: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function foreignCursor() {
  return badRequest('cursor: not a cursor this list issued', { field: 'cursor' });
}

/** Encode the cursor that resumes at `offset`. Deterministic for equal inputs. */
export function encodePublicCursor(
  kind: MercariaPublicCursorKind,
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
 * @throws `bad_request` for a cursor that is not base64url JSON of the current
 * version, belongs to another list kind, was minted under different filters, or
 * claims an offset outside `1..MERCARIA_PUBLIC_LIST_MAX_OFFSET - 1`.
 */
export function resolvePublicCursorOffset(
  raw: string | undefined,
  kind: MercariaPublicCursorKind,
  fingerprint: string,
): number {
  if (raw === undefined) return 0;
  const parsed = payloadSchema.safeParse(decodePayload(raw));
  if (!parsed.success || parsed.data.k !== kind || parsed.data.f !== fingerprint) {
    throw foreignCursor();
  }
  return parsed.data.o;
}

/** Encode the public cursor that wraps a keyset list's own next-page cursor. */
export function encodePublicKeysetCursor(
  kind: MercariaPublicCursorKind,
  fingerprint: string,
  inner: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: kind, f: fingerprint, s: inner }),
    'utf8',
  ).toString('base64url');
}

/**
 * The keyset cursor a request's public cursor wraps — `undefined` with no cursor.
 *
 * @throws `bad_request` on the same terms as {@link resolvePublicCursorOffset}.
 */
export function resolvePublicKeysetCursor(
  raw: string | undefined,
  kind: MercariaPublicCursorKind,
  fingerprint: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = searchPayloadSchema.safeParse(decodePayload(raw));
  if (!parsed.success || parsed.data.k !== kind || parsed.data.f !== fingerprint) {
    throw foreignCursor();
  }
  return parsed.data.s;
}

/**
 * How many items a page starting at `offset` may serve: the requested `limit`,
 * cut so no page reaches past `MERCARIA_PUBLIC_LIST_MAX_OFFSET`.
 */
export function clampPublicPageLimit(offset: number, limit: number): number {
  return Math.max(0, Math.min(limit, MERCARIA_PUBLIC_LIST_MAX_OFFSET - offset));
}

/**
 * The cursor for the page after one that started at `offset` and served
 * `served` items, or `null` when there is none (or the depth ceiling is reached).
 */
export function nextPublicCursor(
  kind: MercariaPublicCursorKind,
  fingerprint: string,
  offset: number,
  served: number,
  hasMore: boolean,
): string | null {
  const next = offset + served;
  if (!hasMore || served === 0 || next >= MERCARIA_PUBLIC_LIST_MAX_OFFSET) return null;
  return encodePublicCursor(kind, fingerprint, next);
}
