/**
 * The observation content hash — the value the `source_records` convergence
 * unique keys on. What matters is exactly two properties: structurally equal
 * payloads hash IDENTICALLY regardless of construction order (or every re-run
 * mints a new row, silently, forever), and different content hashes
 * differently (or two different observations converge into one).
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHashOf } from '../content-hash.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order — order is content', () => {
    expect(canonicalJson({ list: [2, 1] })).toBe('{"list":[2,1]}');
    expect(canonicalJson({ list: [1, 2] })).not.toBe(canonicalJson({ list: [2, 1] }));
  });

  it('drops undefined-valued keys rather than serializing them unstably', () => {
    const withUndefined: Record<string, string | undefined> = { a: 'x', gone: undefined };
    expect(canonicalJson(withUndefined as never)).toBe('{"a":"x"}');
  });
});

describe('contentHashOf', () => {
  it('is key-order independent', () => {
    expect(contentHashOf({ b: 1, a: 'x' })).toBe(contentHashOf({ a: 'x', b: 1 }));
  });

  it('is 64 lowercase hex characters — the shape the CHECK constraint demands', () => {
    expect(contentHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates different content', () => {
    expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
    expect(contentHashOf({ a: '1' })).not.toBe(contentHashOf({ a: 1 }));
  });
});
