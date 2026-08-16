/**
 * The two resolution rules, driven directly (#367 step 8, ADR 0007 D8).
 *
 * `resolveApplicability` and `resolveFitment` are pure and live in
 * `@mercaria/shared-types` so the backend and both clients reach the same answer
 * from the same rows. They are the whole of "unknown is not false" and the whole
 * of the exclusion mechanism, so every branch is pinned here rather than left to
 * a realdb suite that also has fixtures to build.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_APPLICABILITY_SEVERITY,
  fitmentScopeSpecificity,
  resolveApplicability,
  resolveFitment,
  type CompatibilityApplicability,
  type FitmentStatement,
} from '@mercaria/shared-types';

describe('resolveApplicability — unknown is not false', () => {
  it('answers `unknown` for an empty set', () => {
    // Nobody said anything, which is exactly what `unknown` means. Answering
    // `does_not_apply` here would tell a shopper their car is excluded on the
    // strength of a gap in a feed.
    expect(resolveApplicability([])).toBe('unknown');
  });

  it('lets a single `does_not_apply` beat any number of `applies`', () => {
    expect(resolveApplicability(['applies', 'applies', 'applies', 'does_not_apply'])).toBe(
      'does_not_apply',
    );
  });

  it('lets `unknown` beat `partially_applies` and `applies`', () => {
    expect(resolveApplicability(['applies', 'unknown'])).toBe('unknown');
    expect(resolveApplicability(['partially_applies', 'unknown'])).toBe('unknown');
  });

  it('lets `partially_applies` beat `applies`', () => {
    expect(resolveApplicability(['applies', 'partially_applies'])).toBe('partially_applies');
  });

  it('answers `applies` only when every statement does', () => {
    expect(resolveApplicability(['applies', 'applies'])).toBe('applies');
  });

  it('is order-independent — the property, over every permutation of the tuple', () => {
    // A resolution that depended on order would produce a different answer for
    // one pairing depending on which source was crawled first, and nothing in
    // the output would say so.
    const values: CompatibilityApplicability[] = [
      'applies',
      'partially_applies',
      'does_not_apply',
      'unknown',
    ];
    const permutations = permute(values);
    expect(permutations.length).toBe(24);
    for (const permutation of permutations) {
      expect(resolveApplicability(permutation)).toBe('does_not_apply');
    }
  });

  it('ignores a value outside the vocabulary rather than resolving to it', () => {
    // The CHECK makes this unreachable from the database, and the guard exists
    // because the function is also called on client-supplied shapes. Note it
    // resolves to the REST of the set, not to `unknown` — dropping a real
    // exclusion because an unrelated garbage value sat beside it would be the
    // permissive failure.
    const values = ['does_not_apply', 'nonsense'] as readonly CompatibilityApplicability[];
    expect(resolveApplicability(values)).toBe('does_not_apply');
  });

  it('the severity tuple is the ordering the function reads, worst first', () => {
    expect(COMPATIBILITY_APPLICABILITY_SEVERITY).toEqual([
      'does_not_apply',
      'unknown',
      'partially_applies',
      'applies',
    ]);
  });
});

describe('resolveFitment — the narrowest scope decides', () => {
  it('answers `unknown` with no statements at all', () => {
    expect(resolveFitment([])).toEqual({ outcome: 'unknown' });
  });

  it('the unknown branch carries no applicability to misread', () => {
    // #74's `RankingSignalOutcome` device: a caller cannot render "we do not
    // know" as a fit by reading a field that is not there.
    const verdict = resolveFitment([]);
    expect('applicability' in verdict).toBe(false);
    expect('decidedAtScope' in verdict).toBe(false);
  });

  it('lets a configuration-scoped exclusion beat a generation-scoped fit', () => {
    // THE exclusion case, and the reason there is no exclusions table: the row
    // that says "but not the sport package" is an ordinary fitment at a narrower
    // scope.
    const statements: FitmentStatement[] = [
      { scope: 'vehicle_generation', applicability: 'applies' },
      { scope: 'vehicle_configuration', applicability: 'does_not_apply' },
    ];
    expect(resolveFitment(statements)).toEqual({
      outcome: 'determined',
      applicability: 'does_not_apply',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('lets a narrow FIT beat a broad exclusion, which is the same rule', () => {
    // "This part does not fit the model, EXCEPT the 2019 facelift." If the
    // specificity rule only worked in the cautious direction it would be a
    // pessimism rule rather than a specificity rule, and the facelift owner
    // would be told the part does not fit their car.
    const statements: FitmentStatement[] = [
      { scope: 'vehicle_model', applicability: 'does_not_apply' },
      { scope: 'vehicle_configuration', applicability: 'applies' },
    ];
    expect(resolveFitment(statements)).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('resolves a contradiction WITHIN one scope cautiously', () => {
    const statements: FitmentStatement[] = [
      { scope: 'vehicle_generation', applicability: 'applies' },
      { scope: 'vehicle_generation', applicability: 'does_not_apply' },
    ];
    expect(resolveFitment(statements)).toEqual({
      outcome: 'determined',
      applicability: 'does_not_apply',
      decidedAtScope: 'vehicle_generation',
    });
  });

  it('ignores broader statements entirely once a narrower one exists', () => {
    // Including a broader `does_not_apply`, which is what makes the previous
    // case a real override rather than a tie the severity rule happened to win.
    const statements: FitmentStatement[] = [
      { scope: 'vehicle_make', applicability: 'does_not_apply' },
      { scope: 'vehicle_model', applicability: 'does_not_apply' },
      { scope: 'vehicle_generation', applicability: 'does_not_apply' },
      { scope: 'vehicle_configuration', applicability: 'applies' },
    ];
    expect(resolveFitment(statements)).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('answers at the make scope when that is all there is', () => {
    expect(resolveFitment([{ scope: 'vehicle_make', applicability: 'applies' }])).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_make',
    });
  });

  it('is order-independent', () => {
    const statements: FitmentStatement[] = [
      { scope: 'vehicle_configuration', applicability: 'does_not_apply' },
      { scope: 'vehicle_make', applicability: 'applies' },
      { scope: 'vehicle_generation', applicability: 'applies' },
    ];
    const forward = resolveFitment(statements);
    const reverse = resolveFitment([...statements].reverse());
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({
      outcome: 'determined',
      applicability: 'does_not_apply',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('the specificity ordering is what it claims to be', () => {
    // Reverse the ladder and every exclusion in the database silently stops
    // applying, while every query still returns rows and every page renders.
    expect(fitmentScopeSpecificity('vehicle_make')).toBeLessThan(
      fitmentScopeSpecificity('vehicle_model'),
    );
    expect(fitmentScopeSpecificity('vehicle_model')).toBeLessThan(
      fitmentScopeSpecificity('vehicle_generation'),
    );
    expect(fitmentScopeSpecificity('vehicle_generation')).toBeLessThan(
      fitmentScopeSpecificity('vehicle_configuration'),
    );
  });
});

/** Every permutation of a small list, for the order-independence property. */
function permute<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += 1) {
    const head = values[index];
    if (head === undefined) continue;
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permute(rest)) {
      output.push([head, ...tail]);
    }
  }
  return output;
}
