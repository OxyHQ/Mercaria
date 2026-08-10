/**
 * Where `seller_declared` sits in #80's confidence classification.
 *
 * #91 added a sixth `NativeListingLinkMethod`, and `CONFIDENT_LINK_METHODS` is
 * derived by SUBTRACTION from that tuple — so the addition silently made it
 * confident. That is the RIGHT answer here and it is a decision, not a default,
 * which is exactly why it needs a test: without one, "we thought about this" and
 * "nobody noticed" produce identical code.
 *
 * The decision, stated once: a `seller_declared` attachment is a NAMED person
 * asserting, about their own item, on a surface that showed them the product,
 * with `match-gate.ts` having refused to write it if a valid identifier, the
 * brand, the pack count, the category, a bundle relation or an operator's own
 * rejection disagreed. Somebody HAS agreed it — which is the whole of what
 * `matcher` lacks and the whole of why `matcher` is excluded.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_LISTING_LINK_METHODS } from '@mercaria/shared-types';
import {
  CONFIDENT_LINK_METHODS,
  PRODUCT_SAVE_MIGRATION_VERSION,
  UNCONFIDENT_LINK_METHODS,
} from '../../product-saves/mapping-version.js';

describe('the confidence classification of a seller-declared attachment', () => {
  it('`seller_declared` is a real link method', () => {
    expect(NATIVE_LISTING_LINK_METHODS).toContain('seller_declared');
  });

  it('a seller-declared attachment IS confident enough to carry a product save', () => {
    expect(
      CONFIDENT_LINK_METHODS,
      'if this ever needs to change, move it into `UNCONFIDENT_LINK_METHODS` deliberately and ' +
        'bump `PRODUCT_SAVE_MIGRATION_VERSION` — do not leave it decided by a filter',
    ).toContain('seller_declared');
  });

  it('`matcher` is still the ONLY unconfident method, which is what the exclusion means', () => {
    expect([...UNCONFIDENT_LINK_METHODS]).toEqual(['matcher']);
  });

  it('the migration version moved with the rule change', () => {
    // The file's own instruction: bump when the RULES change — "a different
    // source of the canonical attachment" is exactly what a sixth confident
    // method is. Without the bump, `UNIQUE(favorite_id, migration_version)`
    // would stop a favorite an earlier run skipped from ever being re-examined.
    expect(PRODUCT_SAVE_MIGRATION_VERSION).not.toBe('2026-08-09.1');
  });
});
