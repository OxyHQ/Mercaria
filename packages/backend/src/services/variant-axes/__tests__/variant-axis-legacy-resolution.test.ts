/**
 * The deterministic legacy resolver (#367 step 4, ADR 0007 D6).
 *
 * The case this file exists for is `Tono`: a Spanish option name that MEANS
 * colour and that this resolver must refuse to type, because the only thing
 * saying so is a resemblance. Everything else here is the machinery that makes
 * that refusal a property rather than a habit.
 *
 * ## Which refusals the BACKFILL can actually produce, stated rather than implied
 *
 * A closed refusal vocabulary is only worth having if a reader can tell which
 * members are reachable. Four of the five attribute refusals are reachable from
 * the backfill (`unmapped`, `forbidden_as_axis`, `not_variant_defining`,
 * `ambiguous`) and each is exercised below. `operator_refused` is reachable ONLY
 * from a person settling a claim — the resolver has no branch that produces it —
 * and the last case in this file says so rather than leaving a member nothing
 * produces looking like coverage.
 */

import { describe, expect, it } from 'vitest';
import {
  VARIANT_AXIS_ATTRIBUTE_REFUSALS,
  VARIANT_AXIS_VALUE_REFUSALS,
} from '@mercaria/shared-types';
import type { ResolvedAttributeDefinition } from '../../attributes/definition-registry.service.js';
import {
  legacyOptionNameToKey,
  resolveLegacyOption,
  resolveLegacyOptionName,
  resolveLegacyOptionValue,
} from '../legacy-resolution.js';

/**
 * A registry definition, built the way #94's OWN hydration builds one.
 *
 * `aliases` maps a normalized alias to the canonical VALUE STRING, and every
 * canonical value is ITS OWN alias — `hydrateMany` in
 * `definition-registry.service.ts`, verbatim. An earlier revision of this helper
 * built the map from enum-value IDS instead, which made the resolver's tests
 * pass against the resolver's own wrong assumption: a test that re-implements
 * the code under test measures the re-implementation. The real bug (every
 * controlled value refused) was found by running the backfill against a real
 * registry, not here.
 */
function definition(input: {
  key: string;
  variantDefining?: boolean;
  valueType?: string;
  enumValues?: readonly { id: string; value: string }[];
  aliases?: Readonly<Record<string, string>>;
  unitFamily?: string;
  baseUnit?: string;
  cardinality?: string;
}): ResolvedAttributeDefinition {
  const enumValues = (input.enumValues ?? []).map((value, index) => ({
    id: value.id,
    attributeDefinitionId: `def_${input.key}`,
    value: value.value,
    label: value.value,
    position: index,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  return {
    row: {
      id: `def_${input.key}`,
      key: input.key,
      version: 1,
      lifecycleState: 'active',
      label: input.key,
      description: null,
      valueType: input.valueType ?? 'enum',
      cardinality: input.cardinality ?? 'single',
      objectivity: 'objective',
      unitFamily: input.unitFamily ?? null,
      baseUnit: input.baseUnit ?? null,
      ratingScaleMax: null,
      currency: null,
      componentAxes: [],
      minValue: null,
      maxValue: null,
      decimalPlaces: null,
      maxLength: null,
      implausibleAbove: null,
      implausibleBelow: null,
      variantDefining: input.variantDefining ?? true,
      filterable: true,
      sortable: false,
      comparable: true,
      hardConstraintCapable: false,
      displayPolicy: 'public',
      evidencePolicy: 'source_required',
      createdByOxyUserId: null,
      publishedByOxyUserId: null,
      publishedAt: null,
      deprecatedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    enumValues,
    // The canonical self-alias, applied AFTER the recorded ones exactly as
    // `hydrateMany` does — so a recorded alias colliding with a canonical value
    // is resolved in the canonical's favour here too.
    aliases: (() => {
      const map = new Map<string, string>();
      for (const [alias, target] of Object.entries(input.aliases ?? {})) {
        const value = enumValues.find((entry) => entry.id === target);
        if (value) map.set(alias, value.value);
      }
      for (const value of enumValues) map.set(value.value, value.value);
      return map;
    })(),
    categoryScopes: [],
    labels: [],
  } as unknown as ResolvedAttributeDefinition;
}

const COLOR = definition({
  key: 'color',
  enumValues: [
    { id: 'ev_black', value: 'black' },
    { id: 'ev_blue', value: 'blue' },
  ],
  aliases: { negro: 'ev_black' },
});

describe('legacyOptionNameToKey performs exactly five folds', () => {
  it('lowercases, trims, and converts separators to underscores', () => {
    expect(legacyOptionNameToKey('  Color ')).toBe('color');
    expect(legacyOptionNameToKey('Shoe Size')).toBe('shoe_size');
    expect(legacyOptionNameToKey('Shoe-Size')).toBe('shoe_size');
    expect(legacyOptionNameToKey('Shoe   -  Size')).toBe('shoe_size');
  });

  it('answers null for anything the key pattern refuses', () => {
    // No transliteration, no accent stripping, no translation. `Tamaño` is not a
    // key and the honest answer is that this resolver does not know what it is.
    expect(legacyOptionNameToKey('Tamaño')).toBeNull();
    expect(legacyOptionNameToKey('Talla / Tamaño')).toBeNull();
    expect(legacyOptionNameToKey('2nd colour')).toBeNull();
    expect(legacyOptionNameToKey('')).toBeNull();
    expect(legacyOptionNameToKey('   ')).toBeNull();
  });

  it('never invents a key that was not in the merchant’s own text', () => {
    // The property that makes the fold a spelling convention rather than a
    // lookup: every character of the answer came from the input.
    for (const name of ['Color', 'Shoe Size', 'strap-material', 'CAPACITY']) {
      const key = legacyOptionNameToKey(name);
      expect(key).not.toBeNull();
      expect(name.toLowerCase().replace(/[\s-]+/gu, '_')).toContain(key ?? '');
    }
  });
});

describe('the NAME half refuses rather than guessing', () => {
  it('resolves an exact key match', () => {
    const result = resolveLegacyOptionName({
      rawName: 'Color',
      definition: COLOR,
      collidesWithSiblingOption: false,
    });
    expect(result).toEqual({
      outcome: 'resolved',
      attributeDefinitionId: 'def_color',
      attributeKey: 'color',
      attributeDefinitionVersion: 1,
    });
  });

  it('REFUSES `Tono`, which is the whole point (ADR 0007 D6)', () => {
    // No definition was found for the folded key `tono`, and there is no second
    // mechanism that could reach `color` from it. It stays text and goes in the
    // queue, which is exactly what the ADR asks for.
    expect(
      resolveLegacyOptionName({
        rawName: 'Tono',
        definition: null,
        collidesWithSiblingOption: false,
      }),
    ).toEqual({ outcome: 'refused', refusal: 'unmapped' });
  });

  it('REFUSES `Colour` too — a near-miss is a miss', () => {
    expect(
      resolveLegacyOptionName({
        rawName: 'Colour',
        definition: null,
        collidesWithSiblingOption: false,
      }),
    ).toEqual({ outcome: 'refused', refusal: 'unmapped' });
  });

  it('refuses a forbidden axis key BEFORE consulting the registry', () => {
    // A real catalogue contains an option literally named `Price` or
    // `Vehicle Make`. The answer is no rather than "not yet", so it is decided
    // from the folded key and a definition is never even looked at.
    for (const name of ['Price', 'Vehicle Make', 'vehicle_year_range', 'Compatible With']) {
      const key = legacyOptionNameToKey(name);
      expect(key, `${name} should fold to a key`).not.toBeNull();
      expect(
        resolveLegacyOptionName({
          rawName: name,
          // A definition is supplied deliberately: the refusal must not depend
          // on the registry being unable to answer.
          definition: definition({ key: key ?? '' }),
          collidesWithSiblingOption: false,
        }),
      ).toEqual({ outcome: 'refused', refusal: 'forbidden_as_axis' });
    }
  });

  it('refuses an attribute the registry says does not define variants', () => {
    expect(
      resolveLegacyOptionName({
        rawName: 'Color',
        definition: definition({ key: 'color', variantDefining: false }),
        collidesWithSiblingOption: false,
      }),
    ).toEqual({ outcome: 'refused', refusal: 'not_variant_defining' });
  });

  it('refuses BOTH sides of a sibling collision rather than picking one', () => {
    // `Shoe Size` and `Shoe-Size` on one listing fold to one key. The unique
    // index would refuse the second, and taking whichever came first would type
    // an axis from a coin toss.
    expect(
      resolveLegacyOptionName({
        rawName: 'Shoe Size',
        definition: definition({ key: 'shoe_size' }),
        collidesWithSiblingOption: true,
      }),
    ).toEqual({ outcome: 'refused', refusal: 'ambiguous' });
  });

  it('refuses a definition whose key is not the one that was folded', () => {
    // Cheap to check, and the alternative is a silent mis-typing no constraint
    // can see: the caller looked something else up.
    expect(
      resolveLegacyOptionName({
        rawName: 'Color',
        definition: definition({ key: 'size' }),
        collidesWithSiblingOption: false,
      }),
    ).toEqual({ outcome: 'refused', refusal: 'unmapped' });
  });
});

describe('the VALUE half resolves through recorded evidence only', () => {
  it('resolves a direct controlled-value hit', () => {
    expect(resolveLegacyOptionValue({ rawValue: 'Black', definition: COLOR })).toEqual({
      outcome: 'resolved',
      normalizedValue: 'black',
      enumValueId: 'ev_black',
      normalizedNumber: null,
      normalizedUnit: null,
    });
  });

  it('resolves through an operator-recorded alias', () => {
    // `Negro -> black` is a human statement that this spelling means that value.
    // It resolves the VALUE only, and only within the definition the NAME
    // already settled — an alias can never decide which attribute an option was.
    expect(resolveLegacyOptionValue({ rawValue: 'Negro', definition: COLOR })).toEqual({
      outcome: 'resolved',
      normalizedValue: 'black',
      enumValueId: 'ev_black',
      normalizedNumber: null,
      normalizedUnit: null,
    });
  });

  it('refuses a value that matches nothing', () => {
    expect(resolveLegacyOptionValue({ rawValue: 'Verde Bosque', definition: COLOR })).toEqual({
      outcome: 'refused',
      refusal: 'unmapped',
    });
  });

  it('does NOT re-decide a canonical value against a colliding alias', () => {
    // An alias spelt identically to a canonical value, pointing elsewhere. #94's
    // hydration applies the canonical self-alias LAST, so the canonical wins —
    // and this domain accepts that verdict rather than issuing a second one. A
    // second opinion here would be a second authority over the registry's own,
    // and the shape it took in an earlier revision was worse than useless: it
    // reported an ORDINARY direct hit as `ambiguous`.
    const conflicted = definition({
      key: 'color',
      enumValues: [
        { id: 'ev_black', value: 'black' },
        { id: 'ev_jet', value: 'jet' },
      ],
      aliases: { black: 'ev_jet' },
    });
    expect(resolveLegacyOptionValue({ rawValue: 'Black', definition: conflicted })).toEqual({
      outcome: 'resolved',
      normalizedValue: 'black',
      enumValueId: 'ev_black',
      normalizedNumber: null,
      normalizedUnit: null,
    });
  });

  it('says `not_controlled` where no alias could ever exist', () => {
    // Different from `unmapped`, and the difference is what stops an operator
    // being sent to write an alias for an attribute that has no controlled
    // values to alias TO.
    expect(
      resolveLegacyOptionValue({
        rawValue: 'Extra Long',
        definition: definition({ key: 'strap', valueType: 'string', enumValues: [] }),
      }),
    ).toEqual({ outcome: 'refused', refusal: 'not_controlled' });
  });

  it('normalizes a MEASUREMENT axis through #94, so two spellings collide', () => {
    const storage = definition({
      key: 'storage_capacity',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      baseUnit: 'B',
      enumValues: [],
    });
    const a = resolveLegacyOptionValue({ rawValue: '256 GB', definition: storage });
    const b = resolveLegacyOptionValue({ rawValue: '256gb', definition: storage });
    expect(a.outcome).toBe('resolved');
    expect(b.outcome).toBe('resolved');
    if (a.outcome === 'resolved' && b.outcome === 'resolved') {
      expect(a.normalizedValue).toBe(b.normalizedValue);
      expect(a.normalizedNumber).not.toBeNull();
    }
  });

  it('refuses a measurement it cannot read rather than coercing it', () => {
    const storage = definition({
      key: 'storage_capacity',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      baseUnit: 'B',
      enumValues: [],
    });
    expect(
      resolveLegacyOptionValue({ rawValue: 'about a lot', definition: storage }).outcome,
    ).toBe('refused');
  });
});

describe('the two halves are ORDERED, which is the safety property', () => {
  it('a value is not even looked at while its attribute is unresolved', () => {
    const result = resolveLegacyOption({
      rawName: 'Tono',
      rawValue: 'Negro',
      definition: null,
      collidesWithSiblingOption: false,
    });
    expect(result.name).toEqual({ outcome: 'refused', refusal: 'unmapped' });
    // `attribute_unresolved`, NOT `unmapped`: the value is perfectly mappable,
    // and reporting it as unmappable would send somebody to fix the wrong thing.
    expect(result.value).toEqual({ outcome: 'refused', refusal: 'attribute_unresolved' });
  });

  it('an axis DECLARATION has no value to settle, and that is not a refusal', () => {
    const result = resolveLegacyOption({
      rawName: 'Color',
      rawValue: null,
      definition: COLOR,
      collidesWithSiblingOption: false,
    });
    expect(result.name.outcome).toBe('resolved');
    expect(result.value).toBeNull();
  });

  it('settles both halves when both can be settled', () => {
    const result = resolveLegacyOption({
      rawName: 'Color',
      rawValue: 'Negro',
      definition: COLOR,
      collidesWithSiblingOption: false,
    });
    expect(result.name.outcome).toBe('resolved');
    expect(result.value?.outcome).toBe('resolved');
  });
});

describe('which refusals this resolver can produce', () => {
  it('produces four of the five attribute refusals; the fifth is a PERSON’s', () => {
    // Stated rather than left implicit. A vocabulary member nothing produces is
    // a check that cannot fail, and pretending otherwise is how a closed set
    // reads as coverage it does not have.
    const produced = new Set<string>();
    const cases: { rawName: string; definition: ResolvedAttributeDefinition | null; collides: boolean }[] = [
      { rawName: 'Tono', definition: null, collides: false },
      { rawName: 'Price', definition: definition({ key: 'price' }), collides: false },
      { rawName: 'Color', definition: definition({ key: 'color', variantDefining: false }), collides: false },
      { rawName: 'Shoe Size', definition: definition({ key: 'shoe_size' }), collides: true },
    ];
    for (const testCase of cases) {
      const result = resolveLegacyOptionName({
        rawName: testCase.rawName,
        definition: testCase.definition,
        collidesWithSiblingOption: testCase.collides,
      });
      if (result.outcome === 'refused') produced.add(result.refusal);
    }
    expect([...produced].sort()).toEqual([
      'ambiguous',
      'forbidden_as_axis',
      'not_variant_defining',
      'unmapped',
    ]);
    expect(VARIANT_AXIS_ATTRIBUTE_REFUSALS).toContain('operator_refused');
    expect(produced.has('operator_refused')).toBe(false);
  });

  it('produces three of the five value refusals from the CONTROLLED-value path', () => {
    // `unmapped` and `not_controlled` come from `resolveLegacyOptionValue`,
    // `attribute_unresolved` from `resolveLegacyOption`'s ordering. `ambiguous`
    // is NOT reachable through controlled values — the registry's alias map
    // settles that — and comes only from a cardinality that splits one legacy
    // value into several facts. `operator_refused` is a person's alone.
    expect(VARIANT_AXIS_VALUE_REFUSALS.length).toBe(5);
    const multi = definition({
      key: 'ports',
      valueType: 'string',
      cardinality: 'set',
      enumValues: [],
    });
    // A `string` attribute with no controlled values answers `not_controlled`
    // before cardinality is consulted, which is why the split case needs a
    // measurable type — this asserts the ORDER rather than assuming it.
    expect(resolveLegacyOptionValue({ rawValue: 'a, b', definition: multi })).toEqual({
      outcome: 'refused',
      refusal: 'not_controlled',
    });
    expect(VARIANT_AXIS_VALUE_REFUSALS).toContain('operator_refused');
  });
});
