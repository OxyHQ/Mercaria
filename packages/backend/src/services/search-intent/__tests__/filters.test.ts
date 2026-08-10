/**
 * Hard constraints are never silently weakened during retrieval (#95
 * acceptance 3).
 *
 * The property under test is not "the translation is correct" — it is that the
 * translation is TOTAL. #94's constraint language can express `ne`, `not_in`,
 * `missing`, an exclusive bound and an "any of" group; #70's `SearchFilters`
 * can express none of them, so a translator that emitted what it could and
 * dropped the rest would produce a search that runs, returns results and
 * quietly ignores a requirement the shopper stated.
 *
 * Every case below therefore asserts BOTH halves: what reached the filter, and
 * what the enforcement report says about the constraint that did not. A test
 * that only checked the filters would pass under exactly the bug this module
 * exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type {
  HardConstraint,
  PreferenceConstraint,
  ProductConstraint,
  ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { deriveSearchFilters, unenforceableHardConstraints } from '../filters.js';

/**
 * A validated set built by hand.
 *
 * The two partitions are populated through TYPE PREDICATES rather than through
 * an assertion, mirroring `constraint-validation.ts`' own `isHard`/`isPreference`
 * — a constraint enters a list only after its OWN `strength` field has been
 * read, so a fixture cannot put a preference in the hard list and thereby test
 * a shape the validator can never produce.
 */
const isHard = (constraint: ProductConstraint): constraint is HardConstraint =>
  constraint.strength === 'hard';
const isPreference = (constraint: ProductConstraint): constraint is PreferenceConstraint =>
  constraint.strength === 'preference';

const validated = (constraints: readonly ProductConstraint[]): ValidatedConstraintSet => ({
  hard: constraints.filter(isHard),
  preferences: constraints.filter(isPreference),
  evaluationVersion: 'ce-1',
  definitionVersions: {},
  brand: 'validated-constraint-set',
});

const derive = (constraints: readonly ProductConstraint[], slugs: Record<string, string> = {}) =>
  deriveSearchFilters({ set: validated(constraints), categorySlugById: slugs });

describe('constraints that #70 CAN enforce become filters', () => {
  it('an inclusive attribute floor becomes a numeric filter', () => {
    const derived = derive([
      {
        kind: 'attribute',
        id: 'ram',
        scope: 'product',
        explanation: 'Memory of at least 16 GB',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        attributeKey: 'ram',
        definitionVersion: 1,
        predicate: { op: 'gte', value: { type: 'measurement', magnitude: 16, unit: 'GB' } },
      },
    ]);
    expect(derived.filters.attributes).toEqual([{ key: 'ram', minNumber: 16 }]);
    expect(derived.enforcement[0]?.site).toBe('retrieval_filter');
  });

  it('a price ceiling becomes a price filter', () => {
    const derived = derive([
      {
        kind: 'commerce',
        id: 'budget',
        scope: 'product',
        explanation: 'a price of at most 900 EUR',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'offer_price', op: 'lte', currency: 'EUR', amountMinor: 90_000 },
      },
    ]);
    expect(derived.filters.price).toEqual({ currency: 'EUR', maxMinor: 90_000 });
    expect(derived.enforcement[0]?.site).toBe('retrieval_filter');
  });

  it("#94's `external` channel expands to #57's three non-native kinds", () => {
    // Not a widening: the same set under the other vocabulary. Pushing only
    // `external` would silently exclude every affiliate and informational offer
    // from a request that asked for third-party sellers.
    const derived = derive([
      {
        kind: 'commerce',
        id: 'channel',
        scope: 'product',
        explanation: 'From a third-party seller',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'offer_channel', op: 'in', values: ['external'] },
      },
    ]);
    expect(derived.filters.offerKinds).toEqual(['external', 'affiliate', 'informational']);
  });
});

describe('constraints #70 CANNOT enforce are reported, never dropped', () => {
  it('a STRICT price bound is evaluated rather than widened', () => {
    // #70's bounds are inclusive. Widening by one minor unit is a weakening,
    // however small, so the constraint goes to the evaluator instead.
    const derived = derive([
      {
        kind: 'commerce',
        id: 'budget',
        scope: 'product',
        explanation: 'a price under 900 EUR',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'offer_price', op: 'lt', currency: 'EUR', amountMinor: 90_000 },
      },
    ]);
    expect(derived.filters.price).toBeUndefined();
    expect(derived.enforcement[0]?.site).toBe('constraint_evaluation');
  });

  it('a delivered TOTAL is a different question from an offer price', () => {
    const derived = derive([
      {
        kind: 'commerce',
        id: 'budget',
        scope: 'product',
        explanation: 'a total of at most 900 EUR delivered',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'known_total', op: 'lte', currency: 'EUR', amountMinor: 90_000 },
      },
    ]);
    // The bug this case exists to catch: mapping it onto the price filter would
    // answer "under 900 before delivery" to somebody who asked for "under 900
    // delivered".
    expect(derived.filters.price).toBeUndefined();
    expect(derived.enforcement[0]?.site).toBe('constraint_evaluation');
  });

  it('an EXCLUSION has no membership filter and is evaluated', () => {
    const derived = derive([
      {
        kind: 'taxonomy',
        id: 'not-brand',
        scope: 'product',
        explanation: 'Not that brand',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        subject: 'brand',
        op: 'not_in',
        ids: ['brand_1'],
      },
    ]);
    expect(derived.filters.brandIds).toBeUndefined();
    expect(derived.enforcement[0]?.site).toBe('constraint_evaluation');
  });

  it('an "any of" group is evaluated rather than approximated by widening', () => {
    const derived = derive([
      {
        kind: 'any_of',
        id: 'ports',
        scope: 'product',
        explanation: 'USB-C or Thunderbolt',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        members: [
          {
            kind: 'attribute',
            id: 'usb',
            scope: 'product',
            explanation: 'USB-C',
            strength: 'hard',
            missingDataPolicy: 'exclude_when_unknown',
            attributeKey: 'port_type',
            definitionVersion: 1,
            predicate: { op: 'eq', value: { type: 'string', value: 'usb_c' } },
          },
        ],
      },
    ]);
    expect(derived.filters.attributes).toBeUndefined();
    expect(derived.enforcement[0]?.site).toBe('constraint_evaluation');
  });

  it('a category with no resolved SLUG is evaluated, not dropped', () => {
    // #70 filters categories by slug and #94 constrains them by id. A category
    // whose slug did not resolve has no filter representation at all.
    const derived = derive([
      {
        kind: 'taxonomy',
        id: 'category',
        scope: 'product',
        explanation: 'In this category',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        subject: 'category',
        op: 'in',
        ids: ['cat_unknown'],
      },
    ]);
    expect(derived.filters.categorySlugs).toBeUndefined();
    expect(derived.enforcement[0]?.site).toBe('constraint_evaluation');
  });

  it('resolves the SAME category once its slug is known', () => {
    // The fixture that makes the previous case mean something: identical
    // constraint, one extra fact, opposite enforcement site.
    const derived = derive(
      [
        {
          kind: 'taxonomy',
          id: 'category',
          scope: 'product',
          explanation: 'In this category',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          subject: 'category',
          op: 'in',
          ids: ['cat_1'],
        },
      ],
      { cat_1: 'laptops' },
    );
    expect(derived.filters.categorySlugs).toEqual(['laptops']);
    expect(derived.enforcement[0]?.site).toBe('retrieval_filter');
  });
});

describe('a requirement nothing can enforce refuses the plan', () => {
  it('proximity is UNENFORCEABLE — #70 has no parameter to accept it', () => {
    const derived = derive([
      {
        kind: 'commerce',
        id: 'nearby',
        scope: 'product',
        explanation: 'Within 10 km',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: {
          facet: 'proximity',
          op: 'within',
          latitude: 41.4,
          longitude: 2.2,
          radiusMetres: 10_000,
        },
      },
    ]);
    const unenforceable = unenforceableHardConstraints(derived.enforcement);
    expect(unenforceable.map((entry) => entry.constraintId)).toEqual(['nearby']);
    expect(unenforceable[0]?.explanation).toBe('Within 10 km');
  });

  it('reports nothing unenforceable for an ordinary set', () => {
    // The negative control: a helper that returned every entry would satisfy
    // the case above while refusing every real search.
    const derived = derive([
      {
        kind: 'commerce',
        id: 'condition',
        scope: 'product',
        explanation: 'Used',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'condition', op: 'in', values: ['used'] },
      },
    ]);
    expect(unenforceableHardConstraints(derived.enforcement)).toEqual([]);
    expect(derived.filters.conditionGroups).toEqual(['used']);
  });
});

describe('a PREFERENCE never narrows retrieval', () => {
  it('produces no filter and no enforcement entry', () => {
    // A preference that narrowed would be a hard constraint wearing a
    // preference's name — the downgrade-in-reverse #94's two types prevent.
    const derived = derive([
      {
        kind: 'attribute',
        id: 'ram-pref',
        scope: 'product',
        explanation: 'Memory around 16 GB',
        strength: 'preference',
        missingDataPolicy: 'admit_and_report_unknown',
        attributeKey: 'ram',
        definitionVersion: 1,
        predicate: { op: 'eq', value: { type: 'measurement', magnitude: 16, unit: 'GB' } },
      },
    ]);
    expect(derived.filters.attributes).toBeUndefined();
    expect(derived.enforcement).toEqual([]);
  });
});
