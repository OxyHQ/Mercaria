/**
 * The search keyset cursor (#70 "Pagination").
 *
 * The properties under test are the two the issue names — deterministic
 * ordering with no duplicate or missing result across a stable snapshot, and
 * opacity to clients — plus the fingerprint binding, which is what stops a
 * cursor being applied to a query it was not produced for.
 */

import { describe, expect, it } from 'vitest';
import type { SearchFilters } from '@mercaria/shared-types';
import {
  compareSearchPositions,
  decodeSearchCursor,
  encodeSearchCursor,
  isAfterSearchCursor,
  searchQueryFingerprint,
} from '../cursor.js';

const NO_FILTERS: SearchFilters = {};

describe('searchQueryFingerprint', () => {
  it('is stable across the ORDER a client listed a filter in', () => {
    // Two spellings of one query must share a cursor: a client that reordered
    // its brand ids between pages did not ask a different question, and
    // invalidating the cursor there would restart the feed for a reason nobody
    // could see.
    const left = searchQueryFingerprint({
      normalized: 'iphone',
      kinds: ['product', 'brand'],
      filters: { brandIds: ['b1', 'b2'] },
    });
    const right = searchQueryFingerprint({
      normalized: 'iphone',
      kinds: ['brand', 'product'],
      filters: { brandIds: ['b2', 'b1'] },
    });
    expect(left).toBe(right);
  });

  it('changes when any filter actually changes', () => {
    const base = searchQueryFingerprint({ normalized: 'iphone', kinds: ['product'], filters: {} });
    for (const filters of [
      { categorySlugs: ['phones'] },
      { brandIds: ['b1'] },
      { market: 'ES' },
      { price: { currency: 'EUR', maxMinor: 100 } },
      { conditionGroups: ['new' as const] },
      { availability: ['in_stock' as const] },
      { offerKinds: ['native' as const] },
      { officialChannelOnly: true },
      { merchantIds: ['m1'] },
      { attributes: [{ key: 'storage', value: '256' }] },
    ] satisfies SearchFilters[]) {
      expect(
        searchQueryFingerprint({ normalized: 'iphone', kinds: ['product'], filters }),
        `${JSON.stringify(filters)} did not change the fingerprint`,
      ).not.toBe(base);
    }
  });
});

describe('search cursors', () => {
  const fingerprint = searchQueryFingerprint({
    normalized: 'iphone',
    kinds: ['product'],
    filters: NO_FILTERS,
  });

  it('round-trips a position and a depth', () => {
    const encoded = encodeSearchCursor(fingerprint, { score: 0.734_5, kind: 'product', id: 'p1' }, 20);
    const decoded = decodeSearchCursor(encoded, fingerprint);
    expect(decoded).toEqual({ score: 0.734_5, kind: 'product', id: 'p1', depth: 20 });
  });

  it('is opaque — the payload is not readable as a query string', () => {
    const encoded = encodeSearchCursor(fingerprint, { score: 0.5, kind: 'product', id: 'p1' }, 0);
    expect(encoded).not.toContain('product');
    expect(encoded).not.toContain('p1');
  });

  it('refuses a cursor minted for a DIFFERENT query', () => {
    // The property that stops a cursor resuming from a boundary that means
    // nothing in another result set, silently dropping its first page.
    const other = searchQueryFingerprint({
      normalized: 'laptop',
      kinds: ['product'],
      filters: NO_FILTERS,
    });
    const encoded = encodeSearchCursor(fingerprint, { score: 0.5, kind: 'product', id: 'p1' }, 0);
    expect(decodeSearchCursor(encoded, other)).toBeNull();
  });

  it('answers null for anything unreadable, indistinguishably', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('nope').toString('base64url')]) {
      expect(decodeSearchCursor(bad, fingerprint)).toBeNull();
    }
    // A well-formed cursor naming a kind this version does not have.
    const forged = Buffer.from(`sc1|${fingerprint}|0|500000|listing|x`, 'utf8').toString('base64url');
    expect(decodeSearchCursor(forged, fingerprint)).toBeNull();
  });

  it('orders by score DESC, then kind, then id — a TOTAL order', () => {
    const positions = [
      { score: 0.5, kind: 'brand' as const, id: 'b' },
      { score: 0.9, kind: 'product' as const, id: 'p' },
      { score: 0.5, kind: 'product' as const, id: 'a' },
      { score: 0.5, kind: 'product' as const, id: 'b' },
    ];
    const sorted = [...positions].sort(compareSearchPositions);
    expect(sorted.map((position) => `${position.kind}:${position.id}`)).toEqual([
      'product:p',
      'product:a',
      'product:b',
      'brand:b',
    ]);
    // No two distinct rows compare equal, which is what makes a keyset boundary
    // unable to loop or skip on a tie.
    for (let index = 1; index < sorted.length; index += 1) {
      expect(compareSearchPositions(sorted[index - 1], sorted[index])).not.toBe(0);
    }
  });

  it('resumes strictly after the boundary, including across a score tie', () => {
    // The case a cursor on score ALONE would loop on forever: twenty results at
    // the same relevance is the normal shape of an exact-name page.
    const boundary = { score: 0.5, kind: 'product' as const, id: 'b' };
    expect(isAfterSearchCursor(boundary, boundary)).toBe(false);
    expect(isAfterSearchCursor({ score: 0.5, kind: 'product', id: 'c' }, boundary)).toBe(true);
    expect(isAfterSearchCursor({ score: 0.5, kind: 'product', id: 'a' }, boundary)).toBe(false);
    expect(isAfterSearchCursor({ score: 0.4, kind: 'product', id: 'a' }, boundary)).toBe(true);
    expect(isAfterSearchCursor({ score: 0.6, kind: 'product', id: 'z' }, boundary)).toBe(false);
  });

  it('compares on the ROUNDED score, matching what the cursor stores', () => {
    // A float round-tripped through the cursor's integer micro-units must
    // compare identically to the one the scorer produced, or exactly one row per
    // page is repeated or dropped — the quietest pagination bug there is.
    const raw = { score: 0.123_456_789, kind: 'product' as const, id: 'p' };
    const decoded = decodeSearchCursor(encodeSearchCursor(fingerprint, raw, 0), fingerprint);
    expect(decoded).not.toBeNull();
    if (decoded === null) return;
    expect(isAfterSearchCursor(raw, decoded)).toBe(false);
  });
});
