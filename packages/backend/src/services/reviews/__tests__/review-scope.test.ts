/**
 * `review-scope` — the pure vocabulary, table-tested exhaustively.
 *
 * Everything here is a function of the tuples in `@mercaria/shared-types`, so it
 * runs without a database and covers every scope rather than the two a fixture
 * would have happened to use. The exhaustiveness is the point: a scope added
 * later gets checked by these tests without anybody remembering to extend them.
 */

import { describe, expect, it } from 'vitest';
import {
  REVIEW_FORBIDDEN_SCOPES,
  REVIEW_SCOPE_DIMENSION_KEYS,
  REVIEW_SCOPE_TARGET_TYPE,
  REVIEW_SCOPES,
  REVIEW_TARGET_TYPES,
  type ReviewScope,
} from '@mercaria/shared-types';
import {
  SCOPES_A_PURCHASE_CAN_UNLOCK,
  SCOPES_WITH_ENTITY_PROJECTION,
  assertDimensionsForScope,
  assertScopeAllowed,
  scopedTarget,
  targetTypeForScope,
} from '../review-scope.js';

describe('the scope → target-type mapping is total and injective', () => {
  it('maps every scope to a real target type', () => {
    for (const scope of REVIEW_SCOPES) {
      const targetType = targetTypeForScope(scope);
      expect(REVIEW_TARGET_TYPES, `${scope} maps outside the target-type tuple`).toContain(
        targetType,
      );
    }
    // Vacuity floor: an empty tuple would pass the loop above with nothing done.
    expect(REVIEW_SCOPES.length).toBe(5);
  });

  it('maps no two scopes to the same target type', () => {
    // Injectivity is what makes `scope → target column` reversible, which the
    // exclusivity CHECK and the classification job both depend on.
    const targetTypes = REVIEW_SCOPES.map(targetTypeForScope);
    expect(new Set(targetTypes).size).toBe(REVIEW_SCOPES.length);
  });

  it('builds a target that DERIVES its type rather than trusting one', () => {
    for (const scope of REVIEW_SCOPES) {
      const target = scopedTarget(scope, 'target-1');
      expect(target).toEqual({
        scope,
        targetType: REVIEW_SCOPE_TARGET_TYPE[scope],
        targetId: 'target-1',
      });
    }
  });
});

describe('assertScopeAllowed', () => {
  it.each([...REVIEW_FORBIDDEN_SCOPES])('refuses %s BY NAME', (forbidden) => {
    expect(() => assertScopeAllowed(forbidden)).toThrowError(
      new RegExp(`does not compute a '${forbidden}' rating`),
    );
  });

  it('names the alternatives so the refusal is actionable', () => {
    // A refusal that says "no" and stops teaches nothing; this one says what to
    // review instead.
    expect(() => assertScopeAllowed('brand')).toThrowError(/product, merchant/);
  });

  it.each([...REVIEW_SCOPES])('accepts %s', (scope) => {
    // The gate must not be universal, or every legitimate write breaks and the
    // refusals above prove nothing.
    expect(() => assertScopeAllowed(scope)).not.toThrow();
  });

  it('refuses an unknown value differently from a forbidden one', () => {
    // Collapsing the two would hide the interesting failure ("you tried to make
    // a brand rating") inside the boring one ("typo").
    expect(() => assertScopeAllowed('not-a-scope')).toThrowError(/is not a review scope/);
    expect(() => assertScopeAllowed('not-a-scope')).not.toThrowError(/does not compute/);
  });
});

describe('assertDimensionsForScope', () => {
  it('accepts every dimension a scope declares', () => {
    for (const scope of REVIEW_SCOPES) {
      const dimensions = REVIEW_SCOPE_DIMENSION_KEYS[scope].map((key) => ({ key, rating: 3 }));
      expect(() => assertDimensionsForScope(scope, dimensions), `${scope}`).not.toThrow();
    }
  });

  it('refuses every dimension a scope does NOT declare, for every scope', () => {
    // Exhaustive rather than illustrative: each scope is checked against every
    // key outside its own list, so a widened list cannot silently admit one.
    const allKeys = new Set(REVIEW_SCOPES.flatMap((scope) => REVIEW_SCOPE_DIMENSION_KEYS[scope]));
    let refusals = 0;
    for (const scope of REVIEW_SCOPES) {
      const own = new Set<string>(REVIEW_SCOPE_DIMENSION_KEYS[scope]);
      for (const key of allKeys) {
        if (own.has(key)) continue;
        expect(
          () => assertDimensionsForScope(scope, [{ key, rating: 3 }]),
          `${scope} accepted '${key}'`,
        ).toThrowError(new RegExp(`'${key}' is not a dimension of a '${scope}' review`));
        refusals += 1;
      }
    }
    // Vacuity floor: if every scope declared every key there would be nothing to
    // refuse and the loop would pass having asserted nothing.
    expect(refusals).toBeGreaterThan(20);
  });

  it('refuses the same key twice', () => {
    // The unique index would refuse it anyway, but a 500 from a constraint reads
    // like a bug rather than like "you rated `quality` twice".
    expect(() =>
      assertDimensionsForScope('product', [
        { key: 'quality', rating: 5 },
        { key: 'quality', rating: 1 },
      ]),
    ).toThrowError(/rated twice/);
  });

  it('accepts an absent or empty dimension list', () => {
    expect(() => assertDimensionsForScope('product', undefined)).not.toThrow();
    expect(() => assertDimensionsForScope('product', [])).not.toThrow();
  });
});

describe('the two scope SETS the aggregate and eligibility layers read', () => {
  it('a purchase can unlock every scope, and only real scopes', () => {
    const scopes = new Set<ReviewScope>(REVIEW_SCOPES);
    for (const scope of SCOPES_A_PURCHASE_CAN_UNLOCK) {
      expect(scopes.has(scope)).toBe(true);
    }
    expect(SCOPES_A_PURCHASE_CAN_UNLOCK).toHaveLength(REVIEW_SCOPES.length);
  });

  it('a transaction review has NO entity projection', () => {
    // An order line has no rating column, and adding one would turn one buyer's
    // private transaction review into a public star rating on their purchase.
    expect(SCOPES_WITH_ENTITY_PROJECTION).not.toContain('native_transaction');
    // …and the other four DO, so the exclusion is a decision rather than an
    // empty list.
    for (const scope of ['product', 'merchant', 'p2p_listing', 'p2p_seller'] as const) {
      expect(SCOPES_WITH_ENTITY_PROJECTION).toContain(scope);
    }
  });
});
