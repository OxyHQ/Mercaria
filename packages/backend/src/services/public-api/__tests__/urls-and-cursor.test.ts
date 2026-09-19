/**
 * The two pure halves of the public integration surface (#1017) whose exact
 * behaviour another package depends on: the URL rules `@mercaria.co/sdk`'s link
 * helpers mirror byte for byte, and the cursor's refusals.
 */

import { describe, expect, it } from 'vitest';
import { collectionWebUrl, normalizeWebOrigin, productWebUrl, storeWebUrl } from '../urls.js';
import {
  PUBLIC_CURSOR_MAX_OFFSET,
  clampPublicPageLimit,
  encodePublicCursor,
  nextPublicCursor,
  publicCursorFingerprint,
  resolvePublicCursorOffset,
} from '../cursor.js';

describe('the canonical web URLs', () => {
  it('builds the three documented shapes', () => {
    expect(productWebUrl('https://mercaria.co', 'abc')).toBe('https://mercaria.co/products/abc');
    expect(storeWebUrl('https://mercaria.co', 'my-shop')).toBe('https://mercaria.co/stores/my-shop');
    expect(collectionWebUrl('https://mercaria.co', 'my-shop', 'c1')).toBe(
      'https://mercaria.co/stores/my-shop?collection=c1',
    );
  });

  it('strips every trailing slash from the origin and escapes every segment and value', () => {
    expect(normalizeWebOrigin('https://mercaria.co///')).toBe('https://mercaria.co');
    expect(productWebUrl('https://mercaria.co/', 'a/b c')).toBe(
      'https://mercaria.co/products/a%2Fb%20c',
    );
    expect(collectionWebUrl('https://mercaria.co/', 'shop&co', 'x?y=z')).toBe(
      'https://mercaria.co/stores/shop%26co?collection=x%3Fy%3Dz',
    );
  });
});

describe('the public cursor', () => {
  const fingerprint = publicCursorFingerprint('products', { q: 'boots', sort: 'newest' });

  it('round-trips, deterministically, and ignores scope key order and undefined members', () => {
    const cursor = encodePublicCursor('products', fingerprint, 40);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodePublicCursor('products', fingerprint, 40)).toBe(cursor);
    expect(resolvePublicCursorOffset(cursor, 'products', fingerprint)).toBe(40);
    expect(
      publicCursorFingerprint('products', { sort: 'newest', storeId: undefined, q: 'boots' }),
    ).toBe(fingerprint);
    expect(resolvePublicCursorOffset(undefined, 'products', fingerprint)).toBe(0);
  });

  it('refuses a cursor from another list, other filters, a bad offset or no cursor at all', () => {
    const cursor = encodePublicCursor('products', fingerprint, 40);
    const otherFilters = publicCursorFingerprint('products', { q: 'boots', sort: 'price_asc' });
    for (const [raw, kind, print] of [
      [cursor, 'store-products', fingerprint],
      [cursor, 'products', otherFilters],
      [encodePublicCursor('products', fingerprint, 0), 'products', fingerprint],
      [encodePublicCursor('products', fingerprint, PUBLIC_CURSOR_MAX_OFFSET), 'products', fingerprint],
      [encodePublicCursor('products', fingerprint, 1.5), 'products', fingerprint],
      ['not a cursor', 'products', fingerprint],
      [Buffer.from('{"v":2}').toString('base64url'), 'products', fingerprint],
      [Buffer.from('nope').toString('base64url'), 'products', fingerprint],
    ] as const) {
      expect(() => resolvePublicCursorOffset(raw, kind, print)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', httpStatus: 400 }),
      );
    }
  });

  it('ends a list at the depth ceiling rather than walking past it', () => {
    expect(nextPublicCursor('products', fingerprint, 0, 20, true)).not.toBeNull();
    expect(nextPublicCursor('products', fingerprint, 0, 20, false)).toBeNull();
    expect(nextPublicCursor('products', fingerprint, 40, 0, true)).toBeNull();
    expect(clampPublicPageLimit(PUBLIC_CURSOR_MAX_OFFSET - 5, 20)).toBe(5);
    expect(
      nextPublicCursor('products', fingerprint, PUBLIC_CURSOR_MAX_OFFSET - 5, 5, true),
    ).toBeNull();
  });
});
