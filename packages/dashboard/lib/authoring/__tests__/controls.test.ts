/**
 * Which control every value type gets, censused (#367 step 10, ADR 0007 D10).
 *
 * ## The gap this closes
 *
 * `AxisValueControl` covered three of the five entry kinds and nothing could
 * see it. The dashboard runner is `lib/**` only with no renderer, so a decision
 * made inside a component cannot be executed at all; and
 * `validate-authoring-schema-driven.mjs` constrains identity PROPERTY NAMES —
 * its own docblock puts the value vocabularies deliberately out of scope — so
 * all four of its walls stay green if the axis control loses its picker branch
 * and renders a plain box for everything.
 *
 * The concrete cost was live in the shipped seeds rather than hypothetical:
 * `storage_capacity` is `valueType: 'measurement'` over `unitFamily:
 * 'digital_storage'` and `variantCapable: true` in the smartphone package, and
 * the axis control rendered a bare number box with no unit control while
 * `SchemaField` rendered one. The unit was pinned at the base unit with no way
 * for a merchant to change it — on the one axis whose stated purpose is that
 * `256GB` and `256 GB` normalize to the same value.
 *
 * ## Why a census and not a list of cases
 *
 * `ATTRIBUTE_VALUE_TYPES` is a closed tuple somebody will add to. A file of
 * hand-written cases grows a silent hole the moment that happens: the new type
 * simply is not mentioned, every case still passes, and the axis control
 * answers `unsupported` for it in production. So the population is DERIVED from
 * the tuple and the expected set is DECLARED — a type with no decision fails
 * the build naming itself, and the declaration has to be edited by whoever adds
 * it.
 *
 * Both directions are reconciled: a declared expectation matching no value type
 * is as broken as a value type with no expectation, and only the second one is
 * visible without checking.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_VALUE_TYPES,
  type AttributeValueType,
  type AuthoringField,
  type ProductTypeValuePolicy,
  type UnitFamily,
} from '@mercaria/shared-types';

import {
  AXIS_SUPPORTED_KINDS,
  axisValueSupport,
  unitAffordance,
  type AxisValueSupport,
} from '../controls';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function field(
  valueType: AttributeValueType,
  overrides: {
    readonly valuePolicy?: ProductTypeValuePolicy;
    readonly unitFamily?: UnitFamily | null;
    readonly baseUnit?: string | null;
  } = {},
): AuthoringField {
  return {
    id: 'field-1',
    key: 'a_key',
    attributeDefinitionId: 'def-1',
    attributeVersion: 1,
    scope: 'variant',
    requirement: 'optional',
    valuePolicy: overrides.valuePolicy ?? 'typed_scalar',
    variantCapable: true,
    groupId: null,
    position: 0,
    visibilityRule: null,
    validation: {
      valueType,
      cardinality: 'single',
      unitFamily: overrides.unitFamily ?? null,
      baseUnit: overrides.baseUnit ?? null,
      ratingScaleMax: null,
      currency: null,
      componentAxes: [],
      minValue: null,
      maxValue: null,
      decimalPlaces: null,
      maxLength: null,
      implausibleAbove: null,
      implausibleBelow: null,
    },
    controlledValues: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The axis coverage census                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What an axis value control does with each of the nine value types.
 *
 * DECLARED rather than derived from the implementation — a table computed by
 * calling the function it is checking agrees with it by construction and
 * measures nothing. Adding a `valueType` to the registry fails the census below
 * until it appears here, which is the point: somebody has to decide.
 */
const EXPECTED_AXIS_SUPPORT: Readonly<Record<AttributeValueType, AxisValueSupport>> = {
  enum: 'controlled_value',
  integer: 'number',
  decimal: 'number',
  money: 'number',
  measurement: 'number',
  structured: 'number',
  string: 'text',
  date: 'text',
  // A boolean axis is the two rows the matrix already enumerates; a control
  // would be a switch whose only settings are those rows.
  boolean: 'unsupported',
};

describe('every value type has a decided axis control', () => {
  it('covers the whole registry tuple, both directions', () => {
    // The population is the registry's, never a hand-written list.
    const declared = Object.keys(EXPECTED_AXIS_SUPPORT) as readonly AttributeValueType[];

    // A value type with no decision.
    const undecided = ATTRIBUTE_VALUE_TYPES.filter((type) => !declared.includes(type));
    expect(undecided).toEqual([]);

    // A decision naming no value type — invisible without checking, and the
    // shape a stale table takes after a member is renamed upstream.
    const orphaned = declared.filter((type) => !ATTRIBUTE_VALUE_TYPES.includes(type));
    expect(orphaned).toEqual([]);

    // The vacuity floor. An empty tuple satisfies both reconciliations above
    // and reports a clean census over nothing.
    expect(ATTRIBUTE_VALUE_TYPES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(ATTRIBUTE_VALUE_TYPES)('renders %s on an axis as its declared control', (valueType) => {
    expect(axisValueSupport(field(valueType))).toBe(EXPECTED_AXIS_SUPPORT[valueType]);
  });

  /**
   * `valuePolicy: 'canonical_reference'` short-circuits `expectedEntryKind`
   * BEFORE the value type is read, so it is a decision about the policy rather
   * than about any one type — which the per-type census above cannot reach.
   */
  it('refuses a canonical reference as an axis whatever its value type', () => {
    for (const valueType of ATTRIBUTE_VALUE_TYPES) {
      expect(axisValueSupport(field(valueType, { valuePolicy: 'canonical_reference' }))).toBe(
        'unsupported',
      );
    }
  });

  /**
   * The control for the two cases above. `unsupported` is asserted for
   * `boolean` and for every canonical reference; if `axisValueSupport` returned
   * it unconditionally, both would still pass.
   */
  it('does support the three kinds an axis can actually render', () => {
    expect(AXIS_SUPPORTED_KINDS).toHaveLength(3);
    expect(axisValueSupport(field('enum'))).toBe('controlled_value');
    expect(axisValueSupport(field('measurement'))).toBe('number');
    expect(axisValueSupport(field('string'))).toBe('text');
  });
});

/* -------------------------------------------------------------------------- */
/* The unit affordance                                                         */
/* -------------------------------------------------------------------------- */

describe('unitAffordance is the ONE unit decision both renderers make', () => {
  /**
   * The live case. `storage_capacity` in the shipped smartphone package is a
   * `digital_storage` measurement and is `variantCapable`, so this is the exact
   * field whose axis had no unit control.
   */
  it('offers a unit for a measurement, placeholdered with its base unit', () => {
    const affordance = unitAffordance(
      field('measurement', { unitFamily: 'digital_storage', baseUnit: 'GB' }),
    );

    expect(affordance.present).toBe(true);
    // Narrowed through the discriminant rather than asserted on a union member,
    // which is what stops the absent branch carrying a placeholder at all.
    if (affordance.present) expect(affordance.placeholder).toBe('GB');
  });

  it('offers none when the attribute carries no unit family', () => {
    expect(unitAffordance(field('integer')).present).toBe(false);
    expect(unitAffordance(field('string')).present).toBe(false);
  });

  /**
   * A unit family with no base unit is a real registry state, and the
   * affordance is still PRESENT — the merchant has a unit to give even when
   * Mercaria has no default to suggest. Withholding the box would leave the
   * magnitude unqualified with no way to qualify it.
   */
  it('still offers the control when the family has no base unit', () => {
    const affordance = unitAffordance(field('measurement', { unitFamily: 'length', baseUnit: null }));

    expect(affordance.present).toBe(true);
    if (affordance.present) expect(affordance.placeholder).toBe('');
  });

  /**
   * The residual, closed.
   *
   * Everything above pins the shared function; NONE of it stops somebody
   * writing `field.validation.unitFamily === null` back into a component, which
   * is precisely how the two answers diverged the first time. A component
   * cannot be executed by this runner, so a decision taken inside one is a
   * decision no test can reach — the rule therefore has to be about WHERE the
   * decision lives, and that is checkable as text.
   *
   * This is the one assertion in the file that was RED on the pre-fix tree:
   * `SchemaField.tsx` read `validation.unitFamily` directly, and `VariantAxes`
   * failed to, which is the whole bug.
   *
   * Scoped to `components/` rather than the package: `lib/` has three
   * legitimate readers asking three different questions — `controls.ts` (is
   * there a unit control), `answers.ts` (seed a new entry's unit) and
   * `inline-validation.ts` (is a unit required) — and collapsing those would be
   * a worse module than the duplication it prevents.
   */
  it('is the only place a COMPONENT can learn whether a field carries a unit', () => {
    const componentsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../components/catalog-authoring',
    );

    const files = readdirSync(componentsDir).filter((name) => name.endsWith('.tsx'));

    // The vacuity floor. A renamed directory or a bad relative path yields an
    // empty listing, and an empty listing reports a clean tree.
    expect(files.length).toBeGreaterThanOrEqual(10);

    const offenders = files.filter((name) => {
      const source = readFileSync(join(componentsDir, name), 'utf8');
      // Comment lines stripped: these modules document the rule in the same
      // vocabulary, and a census over source must exclude comments.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join('\n');
      return /validation\s*\.\s*unitFamily/u.test(code);
    });

    expect(offenders).toEqual([]);

    // The positive control: the detector matches the shape it hunts for. Without
    // this the assertion above passes against a regex that matches nothing.
    expect(/validation\s*\.\s*unitFamily/u.test('if (field.validation.unitFamily === null) {')).toBe(
      true,
    );
  });

  /**
   * The ENTRYPOINT assertion — everything else here can be green and INERT.
   *
   * Every case above exercises the shared functions in isolation, and the scan
   * above only forbids a component from re-deriving the decision. Neither
   * notices a renderer that simply STOPS CALLING — delete the `unitAffordance`
   * call from `VariantAxes` and render no unit box, and the census still passes,
   * the scan still passes, and the exact bug this change fixed is back.
   *
   * A mechanism nothing calls is not a mechanism, so the callers are named.
   * This is a weaker check than executing the components — which this runner
   * cannot do at all (`lib/**`, no renderer) — and it is the strongest one
   * available at this layer, which is worth saying plainly rather than leaving
   * a reader to assume the coverage is behavioural.
   */
  it('is actually CALLED by both renderers', () => {
    const componentsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../components/catalog-authoring',
    );
    const read = (name: string) => readFileSync(join(componentsDir, name), 'utf8');

    const axes = read('VariantAxes.tsx');
    const schemaField = read('SchemaField.tsx');

    // The unit decision reaches BOTH surfaces. `SchemaField` always had it;
    // `VariantAxes` is the one that did not.
    expect(/unitAffordance\s*\(/u.test(axes)).toBe(true);
    expect(/unitAffordance\s*\(/u.test(schemaField)).toBe(true);

    // And the coverage decision reaches the axis control that dispatches on it.
    expect(/axisValueSupport\s*\(/u.test(axes)).toBe(true);

    // The negative control: these detectors distinguish a CALL from a mention,
    // so a docblock naming the function does not satisfy them.
    expect(/unitAffordance\s*\(/u.test(' * Uses unitAffordance to decide.')).toBe(false);
  });
});
