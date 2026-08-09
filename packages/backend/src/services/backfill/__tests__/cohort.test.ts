/**
 * Cohort parsing and the canonical read predicate (#60 feature flag 6).
 *
 * Both are pure, and both are the kind of thing whose failure is invisible: a
 * cohort that selects nothing looks exactly like a cohort that is finished, and
 * a read predicate that admits everything looks exactly like a rollout that is
 * going well. So the cases below are mostly about the DIRECTION each refusal
 * points in.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_COHORT,
  canonicalReadAllowedFor,
  cohortColumns,
  cohortLabel,
  parseCohort,
} from '../cohort.js';

describe('parseCohort', () => {
  it("accepts 'all' with no value, and refuses one carrying a value", () => {
    expect(parseCohort('all', null)).toEqual(ALL_COHORT);
    expect(parseCohort('all', '')).toEqual(ALL_COHORT);
    expect(() => parseCohort('all', 'store-1')).toThrow(/carries no value/);
  });

  it('refuses every other kind with no value', () => {
    // A half-specified cohort is the dangerous one: `('store', NULL)` reads as a
    // restriction and would silently mean every store.
    for (const kind of ['store', 'category', 'owner_type', 'connector_provider'] as const) {
      expect(() => parseCohort(kind, null)).toThrow(/requires a value/);
      expect(() => parseCohort(kind, '   ')).toThrow(/requires a value/);
    }
  });

  it('refuses an owner type or provider outside its tuple', () => {
    // Both are accepted by the schema's CHECK, which only constrains the KIND,
    // and would select nothing — a clean-looking pass over an empty set.
    expect(() => parseCohort('owner_type', 'merchant')).toThrow(/owner_type must be one of/);
    expect(() => parseCohort('connector_provider', 'etsy-but-not')).toThrow(
      /must be a known provider/,
    );
    expect(parseCohort('owner_type', 'store')).toEqual({ kind: 'owner_type', value: 'store' });
  });

  it('renders its stored columns and its label', () => {
    expect(cohortColumns(ALL_COHORT)).toEqual({ cohortKind: 'all', cohortValue: null });
    expect(cohortColumns(parseCohort('store', 'store-1'))).toEqual({
      cohortKind: 'store',
      cohortValue: 'store-1',
    });
    expect(cohortLabel(ALL_COHORT)).toBe('all');
    expect(cohortLabel(parseCohort('category', 'cat-1'))).toBe('category:cat-1');
  });
});

describe('canonicalReadAllowedFor', () => {
  it('admits everything when no cohort is configured', () => {
    // The `CHECKOUT_DESTINATION_COUNTRIES` rule: an empty list that meant
    // "nothing" would make adding the lever a silent outage.
    expect(canonicalReadAllowedFor([], {})).toBe(true);
    expect(canonicalReadAllowedFor([], { storeId: 'store-1' })).toBe(true);
  });

  it("admits everything for the explicit 'all'", () => {
    expect(canonicalReadAllowedFor(['all'], { storeId: 'store-1' })).toBe(true);
  });

  it('admits a subject in an enabled cohort and refuses one outside every enabled cohort', () => {
    const enabled = ['store:store-1', 'category:cat-2'];
    expect(canonicalReadAllowedFor(enabled, { storeId: 'store-1' })).toBe(true);
    expect(canonicalReadAllowedFor(enabled, { categoryId: 'cat-2' })).toBe(true);
    expect(canonicalReadAllowedFor(enabled, { storeId: 'store-9' })).toBe(false);
  });

  it('REFUSES a subject it cannot classify, rather than admitting it', () => {
    // The load-bearing direction: a canary that leaked the objects it could not
    // classify is not a canary.
    expect(canonicalReadAllowedFor(['store:store-1'], {})).toBe(false);
    expect(canonicalReadAllowedFor(['store:store-1'], { categoryId: 'cat-2' })).toBe(false);
  });

  it('makes a malformed entry match NOTHING rather than everything', () => {
    // A typo in a rollout variable must narrow the rollout, never widen it.
    expect(canonicalReadAllowedFor(['store'], { storeId: 'store-1' })).toBe(false);
    expect(canonicalReadAllowedFor(['store:'], { storeId: 'store-1' })).toBe(false);
    expect(canonicalReadAllowedFor([':store-1'], { storeId: 'store-1' })).toBe(false);
    expect(canonicalReadAllowedFor(['nonsense:store-1'], { storeId: 'store-1' })).toBe(false);
    // …and one good entry beside a malformed one still works.
    expect(canonicalReadAllowedFor(['store', 'store:store-1'], { storeId: 'store-1' })).toBe(true);
  });
});
