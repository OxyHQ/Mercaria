/**
 * The version carry-forward covers EVERY column, and says why where it does not.
 *
 * `merge-plan-census.test.ts`'s device (#59), applied to #568's carry-forward.
 * The failure it exists for is silent in both directions:
 *
 *  - a field the mapping forgets is dropped from the new version, with no error
 *    and no failing test — a filterable attribute quietly stops being one;
 *  - **a column added to `attribute_definitions` next year is not carried and
 *    nothing fails**, which is the same loss arriving later and harder to trace.
 *
 * The column list is READ OFF THE DRIZZLE TABLE. A hand-written list would drift
 * from the schema in precisely the direction that leaves the census green while
 * covering less — "a census that skips what a hand-maintained map omits is not a
 * census".
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { attributeDefinitions } from '../../../db/schema/attributeRegistry.js';
import {
  ATTRIBUTE_VERSION_CARRY_FORWARD,
  buildNextVersionInput,
  type CarriedForwardAddition,
} from '../version-carry-forward.js';
import type { ResolvedAttributeDefinition } from '../definition-registry.service.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

/** Every column the table declares, by drizzle property name. */
function tableColumns(): string[] {
  return Object.keys(getTableColumns(attributeDefinitions)).sort();
}

describe('the carry-forward census', () => {
  it('covers EXACTLY the columns the table declares', () => {
    const columns = tableColumns();
    const dispositions = Object.keys(ATTRIBUTE_VERSION_CARRY_FORWARD).sort();

    // The vacuity floor. A table that resolved to nothing would make both sides
    // empty and the equality below vacuously true.
    expect(columns.length, 'read no columns off attribute_definitions').toBeGreaterThan(20);
    reportPopulation(`[census] attribute_definitions columns: ${columns.length}`);

    const missing = columns.filter((column) => !(column in ATTRIBUTE_VERSION_CARRY_FORWARD));
    const extra = dispositions.filter((column) => !columns.includes(column));

    expect(
      missing,
      'a column has no carry-forward disposition. Decide what a NEW VERSION does with it: ' +
        "carry it, or mark it `{ notCarried: '<reason>' }`.",
    ).toEqual([]);
    expect(
      extra,
      'a disposition names a column the table no longer has; delete it or fix the name.',
    ).toEqual([]);
  });

  it('every `notCarried` states a REASON, because silence is not a decision', () => {
    const withoutReason: string[] = [];
    let notCarried = 0;
    for (const [column, disposition] of Object.entries(ATTRIBUTE_VERSION_CARRY_FORWARD)) {
      if (disposition === 'carried') continue;
      notCarried += 1;
      if (disposition.notCarried.trim().length < 20) withoutReason.push(column);
    }
    // Floor: if nothing were `notCarried` the loop above would assert nothing,
    // and an empty map would pass it just as happily.
    expect(notCarried, 'no column is notCarried — the check measured nothing').toBeGreaterThan(0);
    reportPopulation(`[census] notCarried columns with a stated reason: ${notCarried}`);
    expect(withoutReason, 'a notCarried column has no usable reason').toEqual([]);
  });

  it('carries the identity-bearing columns and refuses to carry the version ones', () => {
    // Named explicitly, so a future edit that flipped one has to say so here.
    // Without this the census above is satisfied by a map that marks EVERYTHING
    // `notCarried` with a sentence.
    for (const column of ['key', 'valueType', 'variantDefining', 'filterable', 'displayPolicy']) {
      expect(ATTRIBUTE_VERSION_CARRY_FORWARD[column], `${column} must be carried`).toBe('carried');
    }
    for (const column of ['id', 'version', 'lifecycleState', 'publishedAt', 'baseUnit']) {
      expect(ATTRIBUTE_VERSION_CARRY_FORWARD[column], `${column} must NOT be carried`).not.toBe(
        'carried',
      );
    }
  });
});

/** A stored enum-value row, whole — the carry-forward reads real rows. */
function enumValueRow(
  value: string,
  label: string,
  position: number,
): ResolvedAttributeDefinition['enumValues'][number] {
  return {
    id: `enum-${value}`,
    attributeDefinitionId: 'def-v1',
    value,
    label,
    position,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
  };
}

/** A resolved definition standing in for a published one, with two values. */
function activeFixture(): ResolvedAttributeDefinition {
  return {
    row: {
      id: 'def-v1',
      key: 'colour',
      version: 1,
      lifecycleState: 'active',
      label: 'Colour',
      description: 'The colour',
      valueType: 'enum',
      cardinality: 'single',
      objectivity: 'objective',
      unitFamily: null,
      baseUnit: null,
      ratingScaleMax: null,
      currency: null,
      componentAxes: [],
      minValue: null,
      maxValue: null,
      decimalPlaces: null,
      maxLength: null,
      implausibleAbove: null,
      implausibleBelow: null,
      variantDefining: true,
      filterable: true,
      sortable: false,
      comparable: true,
      hardConstraintCapable: false,
      displayPolicy: 'public',
      evidencePolicy: 'source_required',
      createdByOxyUserId: 'original-author',
      publishedByOxyUserId: 'original-publisher',
      publishedAt: new Date('2020-01-01T00:00:00Z'),
      deprecatedAt: null,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    } as ResolvedAttributeDefinition['row'],
    enumValues: [
      enumValueRow('red', 'Red', 0),
      enumValueRow('blue', 'Blue', 1),
    ],
    aliases: new Map([
      ['rojo', 'red'],
      ['azul', 'blue'],
    ]),
    categoryScopes: [{ categoryId: 'cat-1', includeDescendants: true }],
    labels: [{ locale: 'es', label: 'Color' }],
  };
}

describe('buildNextVersionInput', () => {
  const addition: CarriedForwardAddition = {
    value: 'rojo_fuego',
    label: 'Rojo Fuego',
    aliases: ['Rojo Fuego'],
  };

  it('keeps the existing vocabulary, its aliases and its ORDER, then appends', () => {
    const input = buildNextVersionInput(activeFixture(), [addition], 'approving-operator');
    expect(input.enumValues?.map((value) => value.value)).toEqual(['red', 'blue', 'rojo_fuego']);
    // Aliases travel with their value. Losing them would make every merchant who
    // types "Rojo" propose the value again against the new version.
    expect(input.enumValues?.[0]?.aliases).toEqual(['rojo']);
    expect(input.enumValues?.[2]?.aliases).toEqual(['Rojo Fuego']);
  });

  it('carries the meaning and the scopes, and does NOT carry publication facts', () => {
    const input = buildNextVersionInput(activeFixture(), [addition], 'approving-operator');
    expect(input.key).toBe('colour');
    expect(input.variantDefining).toBe(true);
    expect(input.filterable).toBe(true);
    expect(input.displayPolicy).toBe('public');
    expect(input.categoryScopes).toEqual([{ categoryId: 'cat-1', includeDescendants: true }]);
    expect(input.labels).toEqual([{ locale: 'es', label: 'Color' }]);

    // The approving operator authors the new version — not whoever wrote v1.
    expect(input.actorOxyUserId).toBe('approving-operator');
    // And the shape has nowhere to put a lifecycle or a publication date, which
    // is what makes "a new version starts draft" structural rather than a rule.
    expect('lifecycleState' in input).toBe(false);
    expect('publishedAt' in input).toBe(false);
    expect('baseUnit' in input).toBe(false);
  });

  it('appends nothing when there is nothing to add', () => {
    const input = buildNextVersionInput(activeFixture(), [], 'approving-operator');
    expect(input.enumValues?.map((value) => value.value)).toEqual(['red', 'blue']);
  });
});
