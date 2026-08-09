/**
 * Constraint validation: rejecting meaningless constraints before search, and
 * producing the ONE partitioned set the evaluator will accept.
 *
 * The registry is mocked so the cases below are about the VALIDATION RULES
 * rather than about seeding a database — the registry's own behaviour is pinned
 * against a real server in `db/__tests__/attribute-registry.realdb.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConstraintSet, ProductConstraint } from '@mercaria/shared-types';
import { benchmarkResolved, fixtureDefinition } from './fixtures/benchmark-catalog.js';
import type { ResolvedAttributeDefinition } from '../definition-registry.service.js';

const registry = new Map<string, ResolvedAttributeDefinition>();
let categoryKeys: string[] | undefined;

vi.mock('../definition-registry.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../definition-registry.service.js')>();
  return {
    ...original,
    resolveActiveDefinition: (_db: unknown, key: string) => Promise.resolve(registry.get(key)),
    resolveDefinitionsForCategory: () =>
      Promise.resolve(
        (categoryKeys ?? [...registry.keys()])
          .map((key) => registry.get(key))
          .filter((value): value is ResolvedAttributeDefinition => value !== undefined),
      ),
  };
});

const { validateConstraintSet } = await import('../constraint-validation.js');
const { resetOfferFactsPort, registerOfferFactsPort } = await import('../offer-facts.port.js');

/** A stand-in for the drizzle handle the mocked registry never uses. */
const db = {} as never;

beforeEach(() => {
  registry.clear();
  categoryKeys = undefined;
  resetOfferFactsPort();
  for (const key of [
    'screen_size',
    'ram_capacity',
    'charging_port',
    'water_resistant',
    'dimensions',
    'msrp',
    'core_count',
    'build_material',
    'editorial_style',
    'warranty_period',
  ]) {
    registry.set(key, benchmarkResolved(key));
  }
});

function set(...constraints: ProductConstraint[]): ConstraintSet {
  return { constraints };
}

function attribute(
  id: string,
  attributeKey: string,
  predicate: Extract<ProductConstraint, { kind: 'attribute' }>['predicate'],
  overrides: Partial<Extract<ProductConstraint, { kind: 'attribute' }>> = {},
): ProductConstraint {
  return {
    kind: 'attribute',
    id,
    scope: 'product',
    explanation: `${attributeKey} requirement`,
    strength: 'hard',
    missingDataPolicy: 'exclude_when_unknown',
    attributeKey,
    definitionVersion: 1,
    predicate,
    ...overrides,
  } as ProductConstraint;
}

describe('a valid set', () => {
  it('is partitioned into hard and preference lists, with the definition versions recorded', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute('ram', 'ram_capacity', {
          op: 'gte',
          value: { type: 'measurement', magnitude: 16, unit: 'GB' },
        }),
        attribute(
          'screen',
          'screen_size',
          { op: 'lte', value: { type: 'measurement', magnitude: 14, unit: 'in' } },
          { strength: 'preference' },
        ),
      ),
    );
    expect(result.valid).toBe(true);
    if (result.valid === false) throw new Error('the set should have validated');
    expect(result.set.hard.map((c) => c.id)).toEqual(['ram']);
    expect(result.set.preferences.map((c) => c.id)).toEqual(['screen']);
    expect(result.set.definitionVersions).toEqual({ ram_capacity: 1, screen_size: 1 });
    expect(result.set.brand).toBe('validated-constraint-set');
  });
});

describe('meaningless constraints are refused before search', () => {
  it('names an unknown attribute', async () => {
    const result = await validateConstraintSet(
      db,
      set(attribute('c', 'no_such_attribute', { op: 'exists' })),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('unknown_attribute');
  });

  it('refuses an attribute that does not apply to the searched category', async () => {
    // `shutter_speed` on a laptop is the issue's own example of a constraint
    // with no answer; returning zero results would say something false about the
    // catalogue.
    registry.set('shutter_speed', benchmarkResolved('shutter_speed'));
    categoryKeys = ['ram_capacity', 'screen_size'];
    const result = await validateConstraintSet(
      db,
      set(attribute('c', 'shutter_speed', { op: 'exists' })),
      { categoryId: 'cat-laptops' },
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('attribute_not_in_category');
  });

  it('refuses an operator the value type does not support', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute(
          'c',
          'build_material',
          { op: 'gte', value: { type: 'string', value: 'aluminium' } },
          // As a PREFERENCE, so the hard-constraint-capability check cannot fire
          // first and mask the one this case is about.
          { strength: 'preference' },
        ),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('operator_not_supported_for_type');
  });

  it('refuses a unit from another dimension, and an unknown unit, differently', async () => {
    const wrongFamily = await validateConstraintSet(
      db,
      set(
        attribute('c', 'screen_size', {
          op: 'lte',
          value: { type: 'measurement', magnitude: 2, unit: 'kg' },
        }),
      ),
    );
    expect(wrongFamily.valid).toBe(false);
    if (wrongFamily.valid !== false) throw new Error('the set should have been refused');
    expect(wrongFamily.issues[0]?.code).toBe('unit_not_in_family');

    const unknown = await validateConstraintSet(
      db,
      set(
        attribute('c', 'screen_size', {
          op: 'lte',
          value: { type: 'measurement', magnitude: 2, unit: 'parsecs' },
        }),
      ),
    );
    expect(unknown.valid).toBe(false);
    if (unknown.valid !== false) throw new Error('the set should have been refused');
    expect(unknown.issues[0]?.code).toBe('unknown_unit');
  });

  it('refuses a currency the attribute is not recorded in', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute(
          'c',
          'msrp',
          { op: 'lte', value: { type: 'money', amountMinor: 100_000, currency: 'USD' } },
          { strength: 'preference' },
        ),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('currency_mismatch');
  });

  it('refuses an enum value the definition does not admit', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute('c', 'charging_port', { op: 'eq', value: { type: 'string', value: 'barrel' } }),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('enum_value_not_allowed');
  });

  it('accepts an enum ALIAS, since the same alias table normalizes stored values', async () => {
    const result = await validateConstraintSet(
      db,
      set(attribute('c', 'charging_port', { op: 'eq', value: { type: 'string', value: 'Type-C' } })),
    );
    expect(result.valid).toBe(true);
  });

  it('refuses an inverted range', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute('c', 'ram_capacity', {
          op: 'between',
          lower: { value: { type: 'measurement', magnitude: 32, unit: 'GB' }, inclusive: true },
          upper: { value: { type: 'measurement', magnitude: 16, unit: 'GB' }, inclusive: true },
        }),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('range_bounds_inverted');
  });

  it('requires a structured constraint to name a component axis, and refuses an undeclared one', async () => {
    const missing = await validateConstraintSet(
      db,
      set(
        attribute('c', 'dimensions', {
          op: 'lte',
          value: { type: 'measurement', magnitude: 20, unit: 'mm' },
        }),
      ),
    );
    expect(missing.valid).toBe(false);
    if (missing.valid !== false) throw new Error('the set should have been refused');
    expect(missing.issues[0]?.code).toBe('axis_not_declared');

    const wrongAxis = await validateConstraintSet(
      db,
      set(
        attribute(
          'c',
          'dimensions',
          { op: 'lte', value: { type: 'measurement', magnitude: 20, unit: 'mm' } },
          { axis: 'diagonal' },
        ),
      ),
    );
    expect(wrongAxis.valid).toBe(false);
    if (wrongAxis.valid !== false) throw new Error('the set should have been refused');
    expect(wrongAxis.issues[0]?.code).toBe('axis_not_declared');
  });

  it('reports EVERY issue, not the first', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute('a', 'no_such_attribute', { op: 'exists' }),
        attribute('b', 'no_other_attribute', { op: 'exists' }),
        attribute('c', 'msrp', {
          op: 'lte',
          value: { type: 'money', amountMinor: 1, currency: 'USD' },
        }),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues).toHaveLength(3);
    expect(result.issues.map((issue) => issue.constraintId).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('the hard/preference boundary', () => {
  it('refuses a HARD constraint on an attribute that may not exclude', async () => {
    // `build_material` is objective and filterable but NOT
    // hard-constraint-capable: it can rank, and it must not remove results.
    const asHard = await validateConstraintSet(
      db,
      set(
        attribute('c', 'build_material', {
          op: 'eq',
          value: { type: 'string', value: 'aluminium' },
        }),
      ),
    );
    expect(asHard.valid).toBe(false);
    if (asHard.valid !== false) throw new Error('the set should have been refused');
    expect(asHard.issues[0]?.code).toBe('attribute_not_hard_constraint_capable');

    // The SAME constraint as a preference is fine — which is what makes the
    // refusal above about the strength rather than about the attribute.
    const asPreference = await validateConstraintSet(
      db,
      set(
        attribute(
          'c',
          'build_material',
          { op: 'eq', value: { type: 'string', value: 'aluminium' } },
          { strength: 'preference' },
        ),
      ),
    );
    expect(asPreference.valid).toBe(true);
  });

  it('refuses a constraint on a non-filterable attribute outright', async () => {
    const result = await validateConstraintSet(
      db,
      set(
        attribute(
          'c',
          'editorial_style',
          { op: 'eq', value: { type: 'string', value: 'sleek' } },
          { strength: 'preference' },
        ),
      ),
    );
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('attribute_not_filterable');
  });
});

describe('lifecycle', () => {
  it('refuses a RETIRED definition and warns about a deprecated one', async () => {
    registry.set(
      'retired_thing',
      fixtureDefinition(
        { key: 'retired_thing', label: 'Retired', valueType: 'string', hardConstraintCapable: false },
        { lifecycleState: 'retired' },
      ),
    );
    const retired = await validateConstraintSet(
      db,
      set(
        attribute('c', 'retired_thing', { op: 'exists' }, { strength: 'preference' }),
      ),
    );
    expect(retired.valid).toBe(false);
    if (retired.valid !== false) throw new Error('the set should have been refused');
    expect(retired.issues[0]?.code).toBe('definition_retired');

    registry.set(
      'deprecated_thing',
      fixtureDefinition(
        {
          key: 'deprecated_thing',
          label: 'Deprecated',
          valueType: 'string',
          hardConstraintCapable: false,
        },
        { lifecycleState: 'deprecated' },
      ),
    );
    const deprecated = await validateConstraintSet(
      db,
      set(attribute('c', 'deprecated_thing', { op: 'exists' }, { strength: 'preference' })),
    );
    // A WARNING, not a refusal: stored values still resolve, so the question is
    // answerable — it is only new values that are no longer recorded.
    expect(deprecated.valid).toBe(true);
    if (deprecated.valid === false) throw new Error('the set should have validated');
    expect(deprecated.warnings[0]?.code).toBe('definition_retired');
  });
});

describe('bounded OR groups', () => {
  it('refuses an empty group and one wider than the bound', async () => {
    const empty = await validateConstraintSet(db, {
      constraints: [
        {
          kind: 'any_of',
          id: 'g',
          scope: 'product',
          explanation: 'either',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          members: [],
        },
      ],
    });
    expect(empty.valid).toBe(false);
    if (empty.valid !== false) throw new Error('the set should have been refused');
    expect(empty.issues.map((issue) => issue.code)).toContain('empty_or_group');

    const wide = await validateConstraintSet(db, {
      constraints: [
        {
          kind: 'any_of',
          id: 'g',
          scope: 'product',
          explanation: 'either',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          members: Array.from({ length: 9 }, (_unused, index) =>
            attribute(`m${String(index)}`, 'ram_capacity', { op: 'exists' }),
          ) as never,
        },
      ],
    });
    expect(wide.valid).toBe(false);
    if (wide.valid !== false) throw new Error('the set should have been refused');
    expect(wide.issues.map((issue) => issue.code)).toContain('or_group_too_wide');
  });
});

describe('commerce constraints', () => {
  it('warn — never refuse — while no offer source is configured', async () => {
    const result = await validateConstraintSet(db, {
      constraints: [
        {
          kind: 'commerce',
          id: 'price',
          scope: 'variant',
          explanation: 'under 300 €',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          predicate: { facet: 'offer_price', op: 'lte', currency: 'EUR', amountMinor: 30_000 },
        },
      ],
    });
    // Refusing would make the same query legal or illegal depending on whether
    // a sibling issue had shipped; the evaluator's named policy is what decides
    // what missing offer data means.
    expect(result.valid).toBe(true);
    if (result.valid === false) throw new Error('the set should have validated');
    expect(result.warnings.map((warning) => warning.code)).toContain('offer_facts_unavailable');
  });

  it('stop warning once a port is registered', async () => {
    registerOfferFactsPort({ factsForVariants: () => Promise.resolve(new Map()) });
    const result = await validateConstraintSet(db, {
      constraints: [
        {
          kind: 'commerce',
          id: 'price',
          scope: 'variant',
          explanation: 'under 300 €',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          predicate: { facet: 'offer_price', op: 'lte', currency: 'EUR', amountMinor: 30_000 },
        },
      ],
    });
    expect(result.valid).toBe(true);
    if (result.valid === false) throw new Error('the set should have validated');
    expect(result.warnings).toHaveLength(0);
  });
});

describe('reserved offer keys', () => {
  it('are refused with a message pointing at the commerce facets', async () => {
    const result = await validateConstraintSet(db, set(attribute('c', 'price', { op: 'exists' })));
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error('the set should have been refused');
    expect(result.issues[0]?.code).toBe('reserved_offer_fact_key');
    expect(result.issues[0]?.message).toContain('commerce constraint facet');
  });
});
