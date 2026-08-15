/**
 * The derived collection code (#93 verification rules 1, 2, 5 and 6).
 *
 * The properties worth pinning are the ones a database dump cannot show,
 * because nothing about this credential is stored: that it is DETERMINISTIC for
 * one (order, version), that a ROTATION changes it and the previous one stops
 * verifying, that it belongs to ONE order, and that its alphabet survives being
 * read aloud at a counter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'a'.repeat(64);

/**
 * The module reads `config.pickup.collectionCodeKey` at CALL time, so the
 * config is mocked rather than the environment set — an env var read at module
 * load would already have been read by the time a test could set it.
 */
vi.mock('../../../config/index.js', () => ({
  config: { pickup: { collectionCodeKey: KEY } },
}));

const {
  collectionCodesAvailable,
  deriveCollectionCode,
  normalizeCollectionCode,
  verifyCollectionCode,
} = await import('../collection-code.js');
const { config } = await import('../../../config/index.js');

describe('deriveCollectionCode', () => {
  it('is deterministic for one order and one version', () => {
    expect(deriveCollectionCode('order-1', 1)).toBe(deriveCollectionCode('order-1', 1));
  });

  it('differs per ORDER, so a code opens exactly one parcel', () => {
    expect(deriveCollectionCode('order-1', 1)).not.toBe(deriveCollectionCode('order-2', 1));
  });

  it('differs per ROTATION, which is what makes a rotation instant', () => {
    expect(deriveCollectionCode('order-1', 1)).not.toBe(deriveCollectionCode('order-1', 2));
  });

  it('uses an alphabet a person can read out', () => {
    const code = deriveCollectionCode('order-1', 1);
    expect(code).toHaveLength(10);
    // No `I`, `L`, `O` or `U`: the first three are misread as `1`, `1` and `0`
    // off a phone screen, and the fourth turns up in words nobody wants on a
    // receipt.
    expect(code).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  });

  it('is not a guest portal token and carries none of their prefixes', () => {
    // #93 verification rule 2. A `mgs_`/`mgx_`/`mgp_` shape would be one a
    // portal resolver could be handed; this one has no prefix at all.
    const code = deriveCollectionCode('order-1', 1);
    expect(code.startsWith('mg')).toBe(false);
  });
});

describe('normalizeCollectionCode', () => {
  it('accepts the grouping a receipt prints', () => {
    const code = deriveCollectionCode('order-1', 1);
    const grouped = `${code.slice(0, 5)}-${code.slice(5)}`;
    expect(normalizeCollectionCode(grouped)).toBe(code);
    expect(normalizeCollectionCode(code.toLowerCase())).toBe(code);
  });

  it('does NOT repair a confusable, because the alphabet excludes them', () => {
    // Silently turning a typed `O` into `0` would turn a wrong code into a
    // different wrong code, and a code containing `O` was not derived here.
    expect(normalizeCollectionCode('O0O0O0O0O0')).toBe('O0O0O0O0O0');
  });
});

describe('verifyCollectionCode', () => {
  it('accepts the current rotation', () => {
    const code = deriveCollectionCode('order-1', 3);
    expect(verifyCollectionCode({ orderId: 'order-1', version: 3, presented: code })).toBe(true);
  });

  it('REFUSES the previous rotation, with no grace window', () => {
    // A rotation happens precisely because the old code should stop working.
    const stale = deriveCollectionCode('order-1', 2);
    expect(verifyCollectionCode({ orderId: 'order-1', version: 3, presented: stale })).toBe(false);
  });

  it('refuses another order’s code', () => {
    const other = deriveCollectionCode('order-2', 1);
    expect(verifyCollectionCode({ orderId: 'order-1', version: 1, presented: other })).toBe(false);
  });

  it('refuses a wrong-length presentation without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so the guard has to come
    // first — a 500 at a counter is worse than a refusal.
    expect(verifyCollectionCode({ orderId: 'order-1', version: 1, presented: 'AB' })).toBe(false);
  });
});

describe('an unconfigured deployment', () => {
  const original = config.pickup.collectionCodeKey;
  beforeEach(() => {
    (config.pickup as { collectionCodeKey: string }).collectionCodeKey = '';
  });
  afterEach(() => {
    (config.pickup as { collectionCodeKey: string }).collectionCodeKey = original;
  });

  it('reports codes unavailable and THROWS rather than deriving a shared one', () => {
    // A placeholder code would be a credential every order shared.
    expect(collectionCodesAvailable()).toBe(false);
    expect(() => deriveCollectionCode('order-1', 1)).toThrow(/not configured/);
  });
});
