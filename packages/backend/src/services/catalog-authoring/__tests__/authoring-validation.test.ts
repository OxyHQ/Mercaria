/**
 * Draft validation, as a table (#367 step 5, ADR 0007 D10).
 *
 * Every case here asserts a CODE and a PATH, never a message — which is the rule
 * under test as much as the rules being tested: ADR 0007 D10 says a client never
 * matches on message text, and a suite that asserted a sentence would be the
 * first thing to break the day somebody localizes one.
 *
 * The `error`/`warning` split gets its own cases, because collapsing them is the
 * failure that makes `recommended` either mandatory or invisible, and both look
 * like the code working.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AttributeCardinality,
  AttributeComponentAxis,
  AuthoringField,
  AuthoringSchema,
  AuthoringValidationCode,
} from '@mercaria/shared-types';
import {
  ATTRIBUTE_CARDINALITIES,
  AUTHORING_VALIDATION_CODES,
  MAX_VALUES_PER_VARIANT_AXIS,
  MAX_VARIANT_AXES_PER_PRODUCT,
  PRODUCT_TYPE_AUTHORING_FLOWS,
} from '@mercaria/shared-types';
import {
  AUTHORING_DEFAULT_MERCHANT_CONDITION,
  CONDITION_REQUIRED_AUTHORING_FLOWS,
  MEDIA_EXPECTED_AUTHORING_FLOWS,
} from '../../../db/schema/catalogAuthoring.js';
import { gs1CheckDigit } from '../../canonical/identifiers.js';
import {
  validateDraft,
  type DraftValidationInput,
  type DraftValueForValidation,
  type DraftVariantForValidation,
} from '../validation.js';

function field(overrides: Partial<AuthoringField> = {}): AuthoringField {
  return {
    id: 'f-colour',
    key: 'colour',
    attributeDefinitionId: 'attr-colour',
    attributeVersion: 1,
    scope: 'product',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: false,
    groupId: null,
    position: 0,
    visibilityRule: null,
    validation: {
      valueType: 'enum',
      cardinality: 'single',
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
    },
    controlledValues: [{ id: 'v-black', value: 'black', position: 0 }],
    ...overrides,
  };
}

function schema(fields: readonly AuthoringField[]): AuthoringSchema {
  return {
    contractVersion: 1,
    productType: {
      definitionId: 'ptd-1',
      key: 'smartphone',
      version: 1,
      lifecycle: 'published',
      pendingProposalPolicy: 'block_publication',
    },
    categoryId: 'cat-1',
    flow: 'merchant',
    market: 'ES',
    locale: {
      requestedLocale: 'en',
      effectiveLocale: 'en',
      step: 'exact',
      coverage: { resolvedInRequestedLocale: 0, total: 0 },
    },
    permissions: {
      canEditDraft: true,
      canPublish: true,
      canProposeValues: false,
      canSelectCanonicalEntity: true,
    },
    steps: [],
    groups: [],
    fields,
    matrix: {
      maxAxes: MAX_VARIANT_AXES_PER_PRODUCT,
      maxValuesPerAxis: MAX_VALUES_PER_VARIANT_AXIS,
      maxVariants: 100,
    },
    text: { groups: {}, fields: {}, values: {} },
    etag: '"authschema-test"',
  };
}

function value(overrides: Partial<DraftValueForValidation> = {}): DraftValueForValidation {
  return {
    fieldId: 'f-colour',
    attributeKey: 'colour',
    draftVariantId: null,
    ordinal: 0,
    componentAxis: null,
    kind: 'controlled_value',
    valueText: null,
    valueNumber: null,
    valueBoolean: null,
    valueEnumValueId: 'v-black',
    canonicalRefId: null,
    unit: null,
    ...overrides,
  };
}

function variant(overrides: Partial<DraftVariantForValidation> = {}): DraftVariantForValidation {
  return {
    id: 'dv-1',
    position: 0,
    priceAmount: 1_000,
    priceCurrency: 'EUR',
    inventoryAvailable: 3,
    axisSignature: 'a'.repeat(64),
    sku: null,
    barcode: null,
    ...overrides,
  };
}

function input(overrides: Partial<DraftValidationInput> = {}): DraftValidationInput {
  return {
    schema: schema([field()]),
    draftSchemaHash: '"authschema-test"',
    status: 'open',
    title: 'A phone',
    description: 'A description',
    // The default fixture is a MERCHANT draft with no stated condition, which is
    // the case #572 leaves publishable — so every unrelated case below stays a
    // case about the rule it names rather than acquiring a condition finding.
    flow: 'merchant',
    itemConditionKey: null,
    // The default fixture carries ONE image, not none. A `merchant` draft with
    // an empty gallery is publishable either way (`MEDIA_EXPECTED_AUTHORING_FLOWS`
    // names only `p2p`), but a default of `[]` would make every media case below
    // pass against a fixture that also happened to be empty — so the default is
    // the populated one and each media case empties it deliberately.
    imageFileIds: ['file-a'],
    variants: [variant()],
    values: [value()],
    categorySelectable: true,
    // EMPTY by default, which is the ordinary draft: every controlled answer the
    // fixture makes is offered by the schema, so nothing is awaiting a
    // publication. The #568 case below populates it deliberately, and the
    // `value_not_in_controlled_set` case above keeps it empty — which is what
    // makes the two cases distinguish the codes rather than share one.
    valuesAwaitingPublication: new Set<string>(),
    categoryInScope: true,
    ...overrides,
  };
}

/** Every code a run produced, for a containment assertion that names the code. */
function codes(result: ReturnType<typeof validateDraft>): AuthoringValidationCode[] {
  return result.findings.map((entry) => entry.code);
}

describe('a complete draft is publishable', () => {
  it('produces no finding at all', () => {
    const result = validateDraft(input());
    expect(result.findings).toEqual([]);
    expect(result.publishable).toBe(true);
  });

  it('carries the schema ETag it was validated against', () => {
    expect(validateDraft(input()).schemaEtag).toBe('"authschema-test"');
  });
});

describe('`error` blocks publication and `warning` does not', () => {
  it('a REQUIRED field left empty is an error', () => {
    const result = validateDraft(
      input({ schema: schema([field({ requirement: 'required' })]), values: [] }),
    );
    expect(codes(result)).toContain('required_field_missing');
    expect(result.findings[0]?.severity).toBe('error');
    expect(result.publishable).toBe(false);
  });

  it('a RECOMMENDED field left empty is reported and still publishes', () => {
    const result = validateDraft(
      input({ schema: schema([field({ requirement: 'recommended' })]), values: [] }),
    );
    const finding = result.findings.find((entry) => entry.code === 'required_field_missing');
    expect(finding?.severity).toBe('warning');
    // The distinction that makes `recommended` a real level rather than a
    // synonym for `optional`: visible, in the same list, and not blocking.
    expect(result.publishable).toBe(true);
  });

  it('an OPTIONAL field left empty is not reported at all', () => {
    expect(validateDraft(input({ values: [] })).findings).toEqual([]);
  });
});

describe('the finding names a stable path and the field it is about', () => {
  it('a product-scope field path is `fields.<attributeKey>`', () => {
    const result = validateDraft(
      input({ schema: schema([field({ requirement: 'required' })]), values: [] }),
    );
    expect(result.findings[0]?.path).toBe('fields.colour');
    expect(result.findings[0]?.fieldId).toBe('f-colour');
    expect(result.findings[0]?.attributeKey).toBe('colour');
  });

  it('a variant-scope field path is `variants[<position>].fields.<attributeKey>`', () => {
    const axis = field({ scope: 'variant', variantCapable: true, requirement: 'required' });
    const result = validateDraft(
      input({ schema: schema([axis]), values: [], variants: [variant({ position: 2 })] }),
    );
    expect(result.findings.some((entry) => entry.path === 'variants[2].fields.colour')).toBe(true);
  });

  it('no finding carries a message property at all', () => {
    const result = validateDraft(
      input({ schema: schema([field({ requirement: 'required' })]), values: [] }),
    );
    for (const finding of result.findings) {
      expect(Object.keys(finding)).not.toContain('message');
    }
  });
});

describe('values are checked against the CITED registry version', () => {
  it('a controlled value outside the set is refused', () => {
    const result = validateDraft(input({ values: [value({ valueEnumValueId: 'v-purple' })] }));
    expect(codes(result)).toContain('value_not_in_controlled_set');
  });

  /**
   * #568: an APPROVED value queued in an unpublished version is a different fact
   * from an invalid one, and the two inputs below differ in EXACTLY one thing.
   *
   * That is what makes the pair a measurement rather than two assertions. The id
   * is outside the composed set in both cases — publication was blocked before
   * this code existed and still is — so if the branch were deleted, the second
   * case would keep failing validation and only the CODE would silently revert to
   * the misleading one.
   */
  it('an approved value awaiting publication is refused by its own code, not as invalid', () => {
    const values = [value({ valueEnumValueId: 'v-purple' })];
    const awaiting = validateDraft(
      input({ values, valuesAwaitingPublication: new Set(['v-purple']) }),
    );
    expect.soft(codes(awaiting)).toContain('approved_value_not_published');
    expect
      .soft(codes(awaiting), 'the honest code did not REPLACE the misleading one')
      .not.toContain('value_not_in_controlled_set');
    // Still an error, so the gate is unchanged in what it PERMITS.
    expect(awaiting.publishable, 'an unpublished approved value must not publish').toBe(false);

    // The control: the same answer with nothing awaiting publication.
    const invalid = validateDraft(input({ values, valuesAwaitingPublication: new Set<string>() }));
    expect.soft(codes(invalid)).toContain('value_not_in_controlled_set');
    expect(codes(invalid), 'the code fired without an awaiting value').not.toContain(
      'approved_value_not_published',
    );
  });

  it('an answer of the wrong KIND is refused', () => {
    const result = validateDraft(
      input({ values: [value({ kind: 'text', valueEnumValueId: null, valueText: 'black' })] }),
    );
    expect(codes(result)).toContain('value_type_mismatch');
  });

  it('a number below the minimum and above the maximum are separate codes', () => {
    const measured = field({
      id: 'f-screen',
      key: 'screen_size',
      attributeDefinitionId: 'attr-screen',
      valuePolicy: 'typed_scalar',
      validation: {
        ...field().validation,
        valueType: 'measurement',
        unitFamily: 'length',
        baseUnit: 'mm',
        minValue: 10,
        maxValue: 20,
      },
      controlledValues: [],
    });
    const base = {
      fieldId: 'f-screen',
      attributeKey: 'screen_size',
      kind: 'number' as const,
      valueEnumValueId: null,
      unit: 'in',
    };
    expect(
      codes(validateDraft(input({ schema: schema([measured]), values: [value({ ...base, valueNumber: 5 })] }))),
    ).toContain('value_below_minimum');
    expect(
      codes(validateDraft(input({ schema: schema([measured]), values: [value({ ...base, valueNumber: 50 })] }))),
    ).toContain('value_above_maximum');
  });

  it('an IMPLAUSIBLE magnitude is a warning, not an error', () => {
    // #94's scale-error detector says "this is probably a decimal-point
    // mistake", which is a different claim from "outside the permitted range".
    // A 40-inch phone screen is almost certainly wrong and just possibly a
    // prototype, and refusing it would make the catalogue unable to record
    // something true.
    const measured = field({
      id: 'f-screen',
      key: 'screen_size',
      attributeDefinitionId: 'attr-screen',
      valuePolicy: 'typed_scalar',
      validation: {
        ...field().validation,
        valueType: 'measurement',
        unitFamily: 'length',
        baseUnit: 'mm',
        implausibleAbove: 20,
      },
      controlledValues: [],
    });
    const result = validateDraft(
      input({
        schema: schema([measured]),
        values: [
          value({
            fieldId: 'f-screen',
            attributeKey: 'screen_size',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 40,
            unit: 'in',
          }),
        ],
      }),
    );
    expect(result.findings.find((entry) => entry.code === 'value_implausible')?.severity).toBe(
      'warning',
    );
    expect(result.publishable).toBe(true);
  });

  it('a magnitude with NO unit is refused rather than imputed to the base unit', () => {
    // #94's normalization rule: a unit comes from the source's own token or a
    // recorded mapping and NEVER from the attribute's base unit. Imputing one
    // here would be inventing what somebody meant.
    const measured = field({
      id: 'f-screen',
      key: 'screen_size',
      attributeDefinitionId: 'attr-screen',
      valuePolicy: 'typed_scalar',
      validation: { ...field().validation, valueType: 'measurement', unitFamily: 'length', baseUnit: 'mm' },
      controlledValues: [],
    });
    const result = validateDraft(
      input({
        schema: schema([measured]),
        values: [
          value({
            fieldId: 'f-screen',
            attributeKey: 'screen_size',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 6.1,
            unit: null,
          }),
        ],
      }),
    );
    expect(codes(result)).toContain('unknown_unit');
  });

  /**
   * The three unit outcomes, measured (#367 step 5).
   *
   * Before these, a `length` attribute accepted `kg` and `bananas` alike and
   * produced ZERO findings — `publishable: true` — because the only unit rule
   * was "is one present". A wrong-family unit then reached
   * `native_variant_axis_assignments.normalized_unit` and became a mass stored
   * as a length, which no later reader can tell from a correct value.
   */
  describe('a unit is checked against the family the attribute declares', () => {
    const measured = field({
      id: 'f-screen',
      key: 'screen_size',
      attributeDefinitionId: 'attr-screen',
      valuePolicy: 'typed_scalar',
      validation: {
        ...field().validation,
        valueType: 'measurement',
        unitFamily: 'length',
        baseUnit: 'mm',
      },
      controlledValues: [],
    });
    const withUnit = (unit: string | null): ReturnType<typeof validateDraft> =>
      validateDraft(
        input({
          schema: schema([measured]),
          values: [
            value({
              fieldId: 'f-screen',
              attributeKey: 'screen_size',
              kind: 'number',
              valueEnumValueId: null,
              valueNumber: 6.1,
              unit,
            }),
          ],
        }),
      );

    it('a unit of the RIGHT family is clean — the positive control', () => {
      // Without this, every case below would pass against a function that
      // refused every unit there is.
      const result = withUnit('in');
      expect(result.findings).toEqual([]);
      expect(result.publishable).toBe(true);
    });

    it('a unit of the WRONG family is its own code, not `unknown_unit`', () => {
      const result = withUnit('kg');
      expect(codes(result)).toContain('unit_not_in_family');
      expect(codes(result)).not.toContain('unknown_unit');
      expect(result.publishable).toBe(false);
    });

    it('a token the unit registry cannot read is `unknown_unit`', () => {
      const result = withUnit('bananas');
      expect(codes(result)).toContain('unknown_unit');
      expect(codes(result)).not.toContain('unit_not_in_family');
    });

    it('the finding names the field path, so a form can highlight it', () => {
      const [entry] = withUnit('kg').findings;
      expect(entry?.path).toBe('fields.screen_size');
      expect(entry?.attributeKey).toBe('screen_size');
    });
  });

  it('a magnitude above the declared RATING SCALE is refused', () => {
    // `ratingScaleMax` was on `AuthoringFieldValidation` and read by nothing, so
    // a 42 on a five-point scale published clean.
    const rated = field({
      id: 'f-rating',
      key: 'energy_rating',
      attributeDefinitionId: 'attr-rating',
      valuePolicy: 'typed_scalar',
      validation: { ...field().validation, valueType: 'decimal', ratingScaleMax: 5 },
      controlledValues: [],
    });
    const rate = (valueNumber: number): ReturnType<typeof validateDraft> =>
      validateDraft(
        input({
          schema: schema([rated]),
          values: [
            value({
              fieldId: 'f-rating',
              attributeKey: 'energy_rating',
              kind: 'number',
              valueEnumValueId: null,
              valueNumber,
            }),
          ],
        }),
      );
    // The positive control first: a value ON the scale is clean, so the refusal
    // below is about the ceiling rather than about numbers being refused.
    expect(rate(4.5).findings).toEqual([]);
    expect(codes(rate(42))).toContain('value_above_maximum');
  });

  it('a `range` whose low bound is above its high bound is refused', () => {
    const ranged = field({
      id: 'f-temp',
      key: 'operating_temperature',
      attributeDefinitionId: 'attr-temp',
      valuePolicy: 'typed_scalar',
      validation: { ...field().validation, valueType: 'decimal', cardinality: 'range' },
      controlledValues: [],
    });
    const bounds = (low: number, high: number): ReturnType<typeof validateDraft> =>
      validateDraft(
        input({
          schema: schema([ranged]),
          values: [
            value({
              fieldId: 'f-temp',
              attributeKey: 'operating_temperature',
              kind: 'number',
              valueEnumValueId: null,
              valueNumber: low,
              ordinal: 0,
            }),
            value({
              fieldId: 'f-temp',
              attributeKey: 'operating_temperature',
              kind: 'number',
              valueEnumValueId: null,
              valueNumber: high,
              ordinal: 1,
            }),
          ],
        }),
      );
    // A well-ordered range is clean, and an equal pair is a legitimate
    // single-point range rather than an inversion.
    expect(bounds(10, 90).findings).toEqual([]);
    expect(bounds(50, 50).findings).toEqual([]);
    expect(codes(bounds(90, 10))).toContain('range_bounds_inverted');
  });

  it('too many decimal places is refused, counted from the DECIMAL rendering', () => {
    const decimal = field({
      id: 'f-weight',
      key: 'weight',
      attributeDefinitionId: 'attr-weight',
      valuePolicy: 'typed_scalar',
      validation: {
        ...field().validation,
        valueType: 'decimal',
        decimalPlaces: 1,
      },
      controlledValues: [],
    });
    const result = validateDraft(
      input({
        schema: schema([decimal]),
        values: [
          value({
            fieldId: 'f-weight',
            attributeKey: 'weight',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 1.234,
          }),
        ],
      }),
    );
    expect(codes(result)).toContain('too_many_decimal_places');
  });

  it('a `single` cardinality refuses a second answer', () => {
    const result = validateDraft(
      input({ values: [value(), value({ ordinal: 1 })] }),
    );
    expect(codes(result)).toContain('cardinality_exceeded');
  });

  it('a `set` cardinality admits several', () => {
    const multi = field({ validation: { ...field().validation, cardinality: 'set' } });
    const result = validateDraft(
      input({ schema: schema([multi]), values: [value(), value({ ordinal: 1 })] }),
    );
    expect(codes(result)).not.toContain('cardinality_exceeded');
  });
});

describe('a structured value needs every declared axis and no other', () => {
  const dimensions = field({
    id: 'f-dims',
    key: 'dimensions',
    attributeDefinitionId: 'attr-dims',
    valuePolicy: 'typed_structured',
    validation: {
      ...field().validation,
      valueType: 'structured',
      unitFamily: 'length',
      baseUnit: 'mm',
      componentAxes: ['width', 'height', 'depth'],
    },
    controlledValues: [],
  });
  const component = (axis: AttributeComponentAxis): DraftValueForValidation =>
    value({
      fieldId: 'f-dims',
      attributeKey: 'dimensions',
      kind: 'number',
      valueEnumValueId: null,
      valueNumber: 10,
      componentAxis: axis,
      unit: 'mm',
    });

  it('a missing axis is reported', () => {
    const result = validateDraft(
      input({ schema: schema([dimensions]), values: [component('width'), component('height')] }),
    );
    expect(codes(result)).toContain('structured_component_missing');
  });

  it('all three axes present is clean', () => {
    const result = validateDraft(
      input({
        schema: schema([dimensions]),
        values: [component('width'), component('height'), component('depth')],
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('an axis the declaration does not name is reported', () => {
    const result = validateDraft(
      input({
        schema: schema([dimensions]),
        values: [
          component('width'),
          component('width'),
          component('height'),
          value({
            fieldId: 'f-dims',
            attributeKey: 'dimensions',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 1,
            componentAxis: 'diagonal',
            unit: 'mm',
          }),
        ],
      }),
    );
    expect(codes(result)).toContain('unknown_component_axis');
  });

  it('three components of one `single` structured value are NOT a cardinality breach', () => {
    // Counting the components as three answers would refuse every single
    // structured value there is — the case a mechanical `answers.length` gets
    // wrong.
    const result = validateDraft(
      input({
        schema: schema([dimensions]),
        values: [component('width'), component('height'), component('depth')],
      }),
    );
    expect(codes(result)).not.toContain('cardinality_exceeded');
  });
});

describe('conditional visibility', () => {
  const guard = field({ id: 'f-kind', key: 'kind', attributeDefinitionId: 'attr-kind' });
  const guarded = field({
    id: 'f-strap',
    key: 'strap_material',
    attributeDefinitionId: 'attr-strap',
    requirement: 'required',
    visibilityRule: { node: 'compare', field: 'kind', op: 'eq', value: 'v-watch' },
  });

  it('a required field whose condition is UNSATISFIED is not demanded', () => {
    const result = validateDraft(
      input({
        schema: schema([guard, guarded]),
        values: [value({ fieldId: 'f-kind', attributeKey: 'kind', valueEnumValueId: 'v-black' })],
      }),
    );
    expect(codes(result)).not.toContain('required_field_missing');
  });

  it('a required field whose condition is UNKNOWN is not demanded either', () => {
    // `effectiveFieldRequirement`'s one policy decision, quoted rather than
    // re-implemented: treating `unknown` as visible deadlocks an authoring form
    // — the author is told a field is required while the field whose answer
    // would decide that is itself not shown yet.
    const result = validateDraft(input({ schema: schema([guard, guarded]), values: [] }));
    expect(codes(result)).not.toContain('required_field_missing');
  });

  it('a required field whose condition is SATISFIED is demanded', () => {
    const result = validateDraft(
      input({
        schema: schema([guard, guarded]),
        values: [value({ fieldId: 'f-kind', attributeKey: 'kind', valueEnumValueId: 'v-watch' })],
      }),
    );
    expect(codes(result)).toContain('required_field_missing');
  });
});

describe('flow requirements', () => {
  it('a FORBIDDEN field carrying an answer is refused', () => {
    const result = validateDraft(input({ schema: schema([field({ requirement: 'forbidden' })]) }));
    expect(codes(result)).toContain('field_forbidden_in_flow');
  });

  it('a HIDDEN field carrying an answer is KEPT and not reported', () => {
    // `hidden` means "this flow does not ask, and a value that arrived another
    // way is kept" — the distinction from `forbidden` that
    // `ProductTypeFieldRequirement` states and that collapsing would lose.
    const result = validateDraft(input({ schema: schema([field({ requirement: 'hidden' })]) }));
    expect(result.findings).toEqual([]);
  });
});

describe('variants', () => {
  it('a draft with no variant is refused', () => {
    expect(codes(validateDraft(input({ variants: [] })))).toContain('no_variant_declared');
  });

  it('a variant with no price is refused, and a missing currency is a different code', () => {
    expect(
      codes(validateDraft(input({ variants: [variant({ priceAmount: null, priceCurrency: null })] }))),
    ).toContain('price_missing');
    expect(
      codes(validateDraft(input({ variants: [variant({ priceCurrency: null })] }))),
    ).toContain('price_currency_missing');
  });

  it('two variants with the same axis signature are refused, naming the SECOND', () => {
    const result = validateDraft(
      input({
        variants: [variant(), variant({ id: 'dv-2', position: 1 })],
      }),
    );
    const finding = result.findings.find((entry) => entry.code === 'duplicate_variant_signature');
    // The path names the duplicate rather than the incumbent: an index can only
    // refuse the write, and an author needs to know WHICH row to change.
    expect(finding?.path).toBe('variants[1]');
  });

  // WHAT THE CASE ABOVE DOES NOT COVER, so nobody counts it for #367's
  // "reject duplicate combinations after normalization": `axisSignature` here is
  // a hand-supplied literal from the `variant()` helper and `validateDraft`
  // never computes one. So it can catch a DETECTOR regression — the loop, the
  // `seenSignatures` set, the path — and can NEVER catch a normalization or an
  // ordering one, because neither is exercised on the way in.
  //
  // Both of those are covered where the digest is actually computed:
  // `services/variant-axes/__tests__/variant-axis-signature.test.ts` for the
  // fold-then-digest composition, and
  // `__tests__/vertical-e2e/vertical-matrix-and-new-product.e2e.realdb.test.ts`
  // for order-independence at three grains against a real server.

  it('an answer on a field the schema does not mark variant-capable is refused', () => {
    const result = validateDraft(
      input({ values: [value({ draftVariantId: 'dv-1' })] }),
    );
    expect(codes(result)).toContain('variant_axis_not_permitted');
  });

  /**
   * A duplicate SKU is REPORTED and still publishes (#367 step 5, #296).
   *
   * `product_variants.sku` is unique at no grain — Shopify enforces none, so one
   * product legitimately carries two variants sharing a code, and #296 dropped
   * the index that refused it. An error here would re-impose in the authoring
   * form exactly the constraint the schema removed for being wrong about real
   * data; saying nothing would hide that `matchIncomingVariant` and
   * `resolveInventoryVariant` can no longer address either variant by SKU.
   */
  describe('a duplicate SKU is a warning, never a refusal', () => {
    const withSkus = (...skus: (string | null)[]): ReturnType<typeof validateDraft> =>
      validateDraft(
        input({
          variants: skus.map((sku, index) => ({
            id: `dv-${index + 1}`,
            position: index,
            priceAmount: 1_000,
            priceCurrency: 'EUR',
            inventoryAvailable: 1,
            axisSignature: String(index).repeat(64),
            sku,
            barcode: null,
          })),
        }),
      );

    it('DISTINCT skus are clean — the positive control', () => {
      const result = withSkus('SKU-1', 'SKU-2');
      expect(result.findings).toEqual([]);
    });

    it('two nulls are not a duplicate', () => {
      expect(withSkus(null, null).findings).toEqual([]);
    });

    it('a repeat is reported as a WARNING and still publishes', () => {
      const result = withSkus('SKU-1', 'SKU-1');
      const entry = result.findings.find((one) => one.code === 'duplicate_variant_sku');
      expect(entry?.severity).toBe('warning');
      expect(result.publishable).toBe(true);
    });

    it('it names the SECOND occurrence, because the first is not the mistake', () => {
      const entry = withSkus('SKU-1', 'SKU-1').findings.find(
        (one) => one.code === 'duplicate_variant_sku',
      );
      expect(entry?.path).toBe('variants[1].sku');
    });

    it('case and surrounding space do not make two codes distinct', () => {
      // Every rail that looks a SKU up folds it, so `sku-1 ` and `SKU-1` are one
      // merchant code — and reporting them as distinct would be the false
      // negative, not the false positive.
      expect(codes(withSkus('SKU-1', ' sku-1 '))).toContain('duplicate_variant_sku');
    });

    it('three sharing one code produce TWO findings, not three', () => {
      const entries = withSkus('SKU-1', 'SKU-1', 'SKU-1').findings.filter(
        (one) => one.code === 'duplicate_variant_sku',
      );
      expect(entries.map((one) => one.path)).toEqual(['variants[1].sku', 'variants[2].sku']);
    });
  });
});

describe('classification and the pin', () => {
  it('a category that is no longer selectable is an error', () => {
    expect(codes(validateDraft(input({ categorySelectable: false })))).toContain(
      'category_not_selectable',
    );
  });

  it('a category outside the version scope is an error', () => {
    expect(codes(validateDraft(input({ categoryInScope: false })))).toContain(
      'category_not_in_product_type_scope',
    );
  });

  it('a SUPERSEDED schema hash is a warning, not an error', () => {
    // ADR 0007 D10: a newer version produces a preview, never a silent rewrite.
    // A draft pins the version it was started under and publishing under that
    // pin is legitimate — which is the whole point of pinning.
    const result = validateDraft(input({ draftSchemaHash: '"authschema-older"' }));
    expect(result.findings.find((e) => e.code === 'schema_version_superseded')?.severity).toBe(
      'warning',
    );
    expect(result.publishable).toBe(true);
  });

  it('a draft that is not open cannot publish', () => {
    const result = validateDraft(input({ status: 'published' }));
    expect(codes(result)).toContain('draft_not_open');
    expect(result.publishable).toBe(false);
  });

  it('an answer citing a field the schema does not declare is REPORTED, not dropped', () => {
    const result = validateDraft(
      input({ values: [value({ fieldId: 'f-gone', attributeKey: 'gone' })] }),
    );
    expect(codes(result)).toContain('unknown_field');
  });

  it('a missing title and a missing description are separate codes', () => {
    expect(codes(validateDraft(input({ title: '   ' })))).toContain('title_missing');
    expect(codes(validateDraft(input({ description: null })))).toContain('description_missing');
  });
});

/**
 * The condition rule (#572).
 *
 * The defect it closes: the draft could not express a condition at all, so
 * `createStoreProductWithin` fell through to `{key: 'new', assertion:
 * 'seller_declared'}` and EVERY authored listing was published as factory-new —
 * declared in the seller's name, about goods nobody described. Harmless for
 * merchant stock; a false statement on `p2p`.
 */
describe('a p2p draft cannot publish without stating a condition', () => {
  it('a p2p draft with NO condition is an ERROR, not a warning', () => {
    const result = validateDraft(input({ flow: 'p2p', itemConditionKey: null }));
    const entry = result.findings.find((one) => one.code === 'condition_missing');
    expect(entry?.severity).toBe('error');
    expect(entry?.path).toBe('condition.itemCondition');
    expect(result.publishable).toBe(false);
  });

  it('a p2p draft that STATES one is clean — the positive control', () => {
    // Without this, the case above would pass against a rule that refused every
    // p2p draft there is.
    const result = validateDraft(input({ flow: 'p2p', itemConditionKey: 'used_good' }));
    expect(result.findings).toEqual([]);
    expect(result.publishable).toBe(true);
  });

  it('a MERCHANT draft with no condition publishes, and is not even reported', () => {
    // The other control, and the one that keeps the rule honest: a warning here
    // would make every merchant draft carry a finding about a default that is
    // ordinarily true, which is how a real finding stops being read.
    const result = validateDraft(input({ flow: 'merchant', itemConditionKey: null }));
    expect(codes(result)).not.toContain('condition_missing');
    expect(result.publishable).toBe(true);
  });

  it('the requirement is read from the TUPLE, so every flow in it is covered', () => {
    // Derived from the exported tuple rather than from a literal `'p2p'`: a
    // sixth flow added to it is covered here without editing this case, and one
    // added to the vocabulary but NOT to the tuple stays permissive on purpose.
    expect(CONDITION_REQUIRED_AUTHORING_FLOWS.length).toBeGreaterThanOrEqual(1);
    for (const flow of CONDITION_REQUIRED_AUTHORING_FLOWS) {
      expect(
        codes(validateDraft(input({ flow, itemConditionKey: null }))),
        `${flow} is in CONDITION_REQUIRED_AUTHORING_FLOWS and does not demand a condition`,
      ).toContain('condition_missing');
    }
    const permissive = PRODUCT_TYPE_AUTHORING_FLOWS.filter(
      (flow) => !CONDITION_REQUIRED_AUTHORING_FLOWS.includes(flow),
    );
    // The victim list is DERIVED from the vocabulary and its length asserted, so
    // a flow removed from the vocabulary cannot silently shrink what is checked.
    expect(permissive.length).toBe(
      PRODUCT_TYPE_AUTHORING_FLOWS.length - CONDITION_REQUIRED_AUTHORING_FLOWS.length,
    );
    for (const flow of permissive) {
      expect(
        codes(validateDraft(input({ flow, itemConditionKey: null }))),
        `${flow} is not in the tuple and must not demand a condition`,
      ).not.toContain('condition_missing');
    }
    console.log(
      `[census] flows: ${PRODUCT_TYPE_AUTHORING_FLOWS.length}, ` +
        `condition-required: ${CONDITION_REQUIRED_AUTHORING_FLOWS.length}, ` +
        `permissive: ${permissive.length}`,
    );
  });
});

describe('the merchant default is NAMED rather than falling out of a write service', () => {
  it('is `new` / `seller_declared` — the exact pair `catalog-write.service.ts` falls back to', () => {
    // The anti-drift pin. `createStoreProductWithin` still carries
    // `resolveConditionInput(input) ?? { key: 'new', assertion: 'seller_declared' }`
    // for its OTHER callers, and #572 deliberately did not change it. What #572
    // changed is that the authoring path STATES its condition rather than
    // falling through — so the two values have to be asserted equal here, or a
    // later edit to either makes an authored listing and a directly-created one
    // disagree about what "unstated" means.
    expect(AUTHORING_DEFAULT_MERCHANT_CONDITION.key).toBe('new');
    expect(AUTHORING_DEFAULT_MERCHANT_CONDITION.assertion).toBe('seller_declared');

    const service = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'catalog-write.service.ts'),
      'utf8',
    );
    // Read from the SOURCE, because the fallback is an inline object literal
    // with no exported name to import. A regex over one statement rather than a
    // loose grep: matching `'new'` anywhere in a 1500-line file would pass
    // against any listing status.
    const fallback =
      /resolveConditionInput\(input\)\s*\?\?\s*\{[\s\S]{0,200}?key:\s*'([a-z_]+)'[\s\S]{0,200}?assertion:\s*'([a-z_]+)'/u.exec(
        service,
      );
    expect(
      fallback,
      'the write service fallback moved or was renamed — re-derive the default rather than deleting this',
    ).not.toBeNull();
    expect(fallback?.[1]).toBe(AUTHORING_DEFAULT_MERCHANT_CONDITION.key);
    expect(fallback?.[2]).toBe(AUTHORING_DEFAULT_MERCHANT_CONDITION.assertion);
  });
});

describe('the code vocabulary is closed and every produced code is in it', () => {
  it('every code this suite produced is a member of AUTHORING_VALIDATION_CODES', () => {
    const produced = new Set<string>();
    const cases: DraftValidationInput[] = [
      input({ schema: schema([field({ requirement: 'required' })]), values: [] }),
      input({ values: [value({ valueEnumValueId: 'v-purple' })] }),
      input({ variants: [] }),
      input({ status: 'published' }),
      input({ categorySelectable: false, categoryInScope: false }),
      input({ title: null, description: null }),
      input({ draftSchemaHash: '"older"' }),
      input({ values: [value({ draftVariantId: 'dv-1' })] }),
    ];
    for (const one of cases) for (const code of codes(validateDraft(one))) produced.add(code);

    // A vacuity floor: a broken `validateDraft` returning nothing would satisfy
    // the containment assertion below and report clean.
    expect(produced.size).toBeGreaterThanOrEqual(8);
    for (const code of produced) {
      expect(AUTHORING_VALIDATION_CODES).toContain(code as AuthoringValidationCode);
    }
  });

  /**
   * The OTHER direction, which the containment above cannot see.
   *
   * `produced ⊆ AUTHORING_VALIDATION_CODES` is satisfied by a vocabulary with
   * ten members nothing produces — and a code in a closed set with no producer
   * is the shape a reviewer reads as coverage: the vocabulary says the rule
   * exists, a client ships a message for it, and the check that would emit it is
   * missing or, worse, unreachable.
   *
   * It found exactly that. `canonical_reference_not_permitted` had a guard,
   * inside a branch only reachable when the field's value policy already
   * permitted a canonical reference — provably dead, with every real occurrence
   * reported as a plain `value_type_mismatch`. That branch is now the one above
   * it, and this census is what would notice if it went dead again.
   *
   * The exemption list is EXPLICIT, is asserted at an exact length, and every
   * member names why. A list that could grow silently would erode to "all of
   * them" one green build at a time.
   */
  it('every code in the closed set has a PRODUCER, or a named exemption', () => {
    const structured = (): AuthoringField =>
      field({
        id: 'f-dim',
        key: 'dimensions',
        attributeDefinitionId: 'attr-dim',
        valuePolicy: 'typed_scalar',
        validation: {
          ...field().validation,
          valueType: 'structured',
          componentAxes: ['length', 'width'] as AttributeComponentAxis[],
        },
        controlledValues: [],
      });
    const numeric = (overrides: Partial<AuthoringField['validation']>): AuthoringField =>
      field({
        id: 'f-num',
        key: 'measure',
        attributeDefinitionId: 'attr-num',
        valuePolicy: 'typed_scalar',
        validation: { ...field().validation, valueType: 'decimal', ...overrides },
        controlledValues: [],
      });
    const numberValue = (overrides: Partial<DraftValueForValidation> = {}) =>
      value({
        fieldId: 'f-num',
        attributeKey: 'measure',
        kind: 'number',
        valueEnumValueId: null,
        valueNumber: 5,
        ...overrides,
      });

    /**
     * Every case below is here to make ONE code fire. The map is keyed by the
     * code so a case that stops producing its code is named by the failure
     * rather than being absorbed into a total.
     */
    const cases: Record<string, DraftValidationInput> = {
      category_not_selectable: input({ categorySelectable: false }),
      category_not_in_product_type_scope: input({ categoryInScope: false }),
      product_type_not_published: input({
        schema: {
          ...schema([field()]),
          productType: { ...schema([field()]).productType, lifecycle: 'draft' },
        },
      }),
      schema_version_superseded: input({ draftSchemaHash: '"older"' }),
      required_field_missing: input({
        schema: schema([field({ requirement: 'required' })]),
        values: [],
      }),
      unknown_field: input({ values: [value({ fieldId: 'f-nowhere' })] }),
      field_forbidden_in_flow: input({ schema: schema([field({ requirement: 'forbidden' })]) }),
      value_type_mismatch: input({ values: [value({ kind: 'text', valueText: 'black' })] }),
      value_not_in_controlled_set: input({ values: [value({ valueEnumValueId: 'v-purple' })] }),
      approved_value_not_published: input({
        values: [value({ valueEnumValueId: 'v-purple' })],
        valuesAwaitingPublication: new Set(['v-purple']),
      }),
      value_below_minimum: input({
        schema: schema([numeric({ minValue: 10 })]),
        values: [numberValue({ valueNumber: 1 })],
      }),
      value_above_maximum: input({
        schema: schema([numeric({ maxValue: 3 })]),
        values: [numberValue({ valueNumber: 9 })],
      }),
      value_too_long: input({
        schema: schema([
          field({
            id: 'f-text',
            key: 'note',
            valuePolicy: 'typed_scalar',
            validation: { ...field().validation, valueType: 'string', maxLength: 2 },
            controlledValues: [],
          }),
        ]),
        values: [
          value({
            fieldId: 'f-text',
            attributeKey: 'note',
            kind: 'text',
            valueEnumValueId: null,
            valueText: 'far too long',
          }),
        ],
      }),
      too_many_decimal_places: input({
        schema: schema([numeric({ decimalPlaces: 1 })]),
        values: [numberValue({ valueNumber: 1.234 })],
      }),
      value_implausible: input({
        schema: schema([numeric({ implausibleAbove: 10 })]),
        values: [numberValue({ valueNumber: 999 })],
      }),
      cardinality_exceeded: input({ values: [value(), value({ ordinal: 1 })] }),
      structured_component_missing: input({
        schema: schema([structured()]),
        values: [
          value({
            fieldId: 'f-dim',
            attributeKey: 'dimensions',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 1,
            componentAxis: 'length' as AttributeComponentAxis,
          }),
        ],
      }),
      unknown_component_axis: input({
        schema: schema([structured()]),
        values: (['length', 'width', 'height'] as AttributeComponentAxis[]).map((axis, index) =>
          value({
            fieldId: 'f-dim',
            attributeKey: 'dimensions',
            kind: 'number',
            valueEnumValueId: null,
            valueNumber: 1,
            ordinal: index,
            componentAxis: axis,
          }),
        ),
      }),
      unknown_unit: input({
        schema: schema([numeric({ valueType: 'measurement', unitFamily: 'length', baseUnit: 'mm' })]),
        values: [numberValue({ unit: null })],
      }),
      unit_not_in_family: input({
        schema: schema([numeric({ valueType: 'measurement', unitFamily: 'length', baseUnit: 'mm' })]),
        values: [numberValue({ unit: 'kg' })],
      }),
      currency_mismatch: input({
        schema: schema([numeric({ valueType: 'money', currency: null })]),
        values: [numberValue()],
      }),
      canonical_reference_not_permitted: input({
        values: [value({ kind: 'canonical_reference', valueEnumValueId: null, canonicalRefId: 'cp-1' })],
      }),
      range_bounds_inverted: input({
        schema: schema([numeric({ cardinality: 'range' })]),
        values: [
          numberValue({ valueNumber: 90, ordinal: 0 }),
          numberValue({ valueNumber: 10, ordinal: 1 }),
        ],
      }),
      no_variant_declared: input({ variants: [] }),
      variant_axis_not_permitted: input({ values: [value({ draftVariantId: 'dv-1' })] }),
      variant_missing_axis_value: input({
        schema: schema([
          field({ scope: 'variant', variantCapable: true, requirement: 'required' }),
        ]),
        values: [],
      }),
      duplicate_variant_signature: input({
        variants: [variant(), variant({ id: 'dv-2', position: 1 })],
      }),
      duplicate_variant_sku: input({
        variants: [
          variant({ sku: 'SKU-1' }),
          variant({ id: 'dv-2', position: 1, axisSignature: 'b'.repeat(64), sku: 'SKU-1' }),
        ],
      }),
      price_missing: input({ variants: [variant({ priceAmount: null })] }),
      price_currency_missing: input({ variants: [variant({ priceCurrency: null })] }),
      inventory_negative: input({ variants: [variant({ inventoryAvailable: -1 })] }),
      title_missing: input({ title: null }),
      description_missing: input({ description: null }),
      condition_missing: input({ flow: 'p2p', itemConditionKey: null }),
      // `p2p` is the one flow that expects media, and the fixture's default
      // gallery is non-empty — so this case empties it rather than relying on a
      // default that would make the assertion pass for the wrong reason.
      media_missing: input({ flow: 'p2p', itemConditionKey: 'used_good', imageFileIds: [] }),
      duplicate_media_file: input({ imageFileIds: ['file-a', 'file-a'] }),
      identifier_check_digit_invalid: input({
        // A real EAN-13 with its last digit changed. `5901234123457` is valid;
        // `…8` is not, and nothing else about the string moved.
        variants: [variant({ barcode: '5901234123458' })],
      }),
      duplicate_variant_barcode: input({
        variants: [
          variant({ barcode: '5901234123457' }),
          variant({ id: 'dv-2', position: 1, axisSignature: 'b'.repeat(64), barcode: '5901234123457' }),
        ],
      }),
      draft_not_open: input({ status: 'published' }),
    };

    // Each case must produce ITS OWN code. Without this, a case that produced
    // some other code would still fill the union below, and a rule could be
    // deleted while the census stayed green.
    const produced = new Set<string>();
    for (const [code, one] of Object.entries(cases)) {
      const got = codes(validateDraft(one));
      expect(got, `the case for ${code} did not produce it`).toContain(code);
      for (const entry of got) produced.add(entry);
    }

    /**
     * The codes no case above produces, each with the reason it cannot.
     * `validateDraft` is PURE, so anything requiring a database read is out of
     * its reach by construction.
     */
    const EXEMPT: Readonly<Record<string, string>> = {
      proposal_pending_blocks_publication:
        'produced by `pendingProposalFindings` in `services/catalog-proposals/publication-gate.ts`, ' +
        'which reads OPEN proposal rows — a database fact this pure function cannot see. ' +
        'Covered by that module’s own suite and merged in by `validateDraftRow`.',
      proposal_not_permitted:
        'has a FACTORY (`proposalNotPermittedFinding`) and NO production caller — only its own ' +
        'test constructs one. The value policy that would trigger it is read at composition ' +
        'time and nothing compares it against a stored proposal reference. This is a real gap ' +
        'in #367 step 6, recorded here rather than hidden by deleting the code.',
      canonical_reference_not_selectable:
        'produced by `canonicalSelectionFindings` in ' +
        '`services/catalog-authoring/canonical-selection.ts`, which resolves every canonical ' +
        'reference a draft holds against `brands`, `canonical_products`, `canonical_variants` ' +
        'and `canonical_product_families` — four database facts this pure function cannot see. ' +
        'Covered by `authoring-canonical-selection.realdb.test.ts` against a real server, with ' +
        'a row in each excluded status, and merged in by `validateDraftRow` beside the ' +
        'collision and proposal findings (#758).',
      identifier_collision:
        'produced by `identifierCollisionFindings` in ' +
        '`services/catalog-authoring/identifier-collision.ts`, which reads `product_identifiers` ' +
        'to ask who already owns a barcode — a database fact this pure function cannot see. ' +
        'Covered by `authoring-identifier-collision.realdb.test.ts` against a real server, and ' +
        'merged in by `validateDraftRow` beside the proposal findings.',
    };

    const missing = AUTHORING_VALIDATION_CODES.filter(
      (code) => !produced.has(code) && EXEMPT[code] === undefined,
    );
    expect(missing, 'these codes are in the closed set and nothing produces them').toEqual([]);

    // The exemption list needs its own exact-count assertion, or it is a hole
    // that widens one green build at a time.
    expect(Object.keys(EXEMPT)).toHaveLength(4);
    for (const code of Object.keys(EXEMPT)) {
      expect(AUTHORING_VALIDATION_CODES, `${code} is exempted and is not in the set`).toContain(
        code as AuthoringValidationCode,
      );
      expect(produced.has(code), `${code} is exempted and IS produced — drop the exemption`).toBe(
        false,
      );
    }

    console.log(
      `[census] codes: ${AUTHORING_VALIDATION_CODES.length}, cases: ${Object.keys(cases).length}, ` +
        `produced: ${produced.size}, exempt: ${Object.keys(EXEMPT).length}`,
    );
    expect(produced.size + Object.keys(EXEMPT).length).toBe(AUTHORING_VALIDATION_CODES.length);
  });
});

/**
 * Cardinality, over the WHOLE vocabulary rather than the two members somebody
 * happened to write a case for.
 *
 * `single` and `set` had cases; `range` and `ordered_list` had none. That is
 * not a tidiness gap: `maxValuesFor`'s `default` branch returns `null` —
 * UNBOUNDED — so a member added to `ATTRIBUTE_CARDINALITIES` and not given a
 * bound admits any number of answers, silently, and the two existing cases go
 * on passing. The failure direction is the permissive one.
 *
 * The add-direction proof is the `Record<AttributeCardinality, …>` below: a new
 * member makes the map incomplete and `tsc` refuses it, so the bound has to be
 * DECIDED before the walk can run. The runtime key-set assertion covers the
 * other direction — a member REMOVED from the tuple leaving a stale key here.
 */
describe('cardinality bounds every member of the vocabulary', () => {
  /** The number of answers each cardinality admits. `null` is unbounded. */
  const CARDINALITY_BOUNDS: Record<AttributeCardinality, number | null> = {
    single: 1,
    // Membership is the only question, so there is nothing to bound.
    set: null,
    // Order is information; length is not.
    ordered_list: null,
    // A low and a high. A third magnitude is a range with no meaning rather
    // than a longer one.
    range: 2,
  };

  const enumField = (cardinality: AttributeCardinality): AuthoringField =>
    field({ validation: { ...field().validation, cardinality } });

  /** `n` answers to the one field, distinguished only by ordinal. */
  const answers = (n: number): DraftValueForValidation[] =>
    Array.from({ length: n }, (_, ordinal) => value({ ordinal }));

  const exceededAt = (cardinality: AttributeCardinality, n: number): boolean =>
    codes(
      validateDraft(input({ schema: schema([enumField(cardinality)]), values: answers(n) })),
    ).includes('cardinality_exceeded');

  it('declares a bound for exactly the members the vocabulary has', () => {
    expect(Object.keys(CARDINALITY_BOUNDS).sort()).toEqual([...ATTRIBUTE_CARDINALITIES].sort());
    // A floor on the walk itself: a vocabulary that shrank to nothing would make
    // every assertion below vacuous while the file still passed.
    expect(ATTRIBUTE_CARDINALITIES.length).toBeGreaterThanOrEqual(4);
  });

  it('admits the bound and refuses one more, for every member', () => {
    for (const cardinality of ATTRIBUTE_CARDINALITIES) {
      const bound = CARDINALITY_BOUNDS[cardinality];
      if (bound === null) {
        // Unbounded is a CLAIM and needs its own evidence: four answers, which
        // is past every finite bound this vocabulary declares.
        expect({ cardinality, exceeded: exceededAt(cardinality, 4) }).toEqual({
          cardinality,
          exceeded: false,
        });
        continue;
      }
      // At the bound: admitted. The positive control — without it a validator
      // that refused EVERY count would satisfy the refusal below.
      expect({ cardinality, at: bound, exceeded: exceededAt(cardinality, bound) }).toEqual({
        cardinality,
        at: bound,
        exceeded: false,
      });
      // One past it: refused, with the offending answer actually present.
      expect({ cardinality, at: bound + 1, exceeded: exceededAt(cardinality, bound + 1) }).toEqual({
        cardinality,
        at: bound + 1,
        exceeded: true,
      });
    }
    process.stdout.write(
      `[cardinality census] members walked: ${ATTRIBUTE_CARDINALITIES.length}\n`,
    );
  });

  it('accepts an unbounded answer set whose ordinals arrive out of order', () => {
    // `set` and `ordered_list` are INDISTINGUISHABLE here, and saying so is the
    // point: `validateDraft` is pure and takes no database, so the difference
    // between them — whether an answer's position is information or only a slot
    // — is carried by `catalog_authoring_draft_values.ordinal` and
    // `canonical_attribute_values.position`, never by a validation rule. What
    // this layer owes is that it refuses NEITHER, including when the ordinals
    // do not arrive sorted: a validator that assumed a contiguous ascending
    // sequence would reject the very shape an unordered set produces.
    const ordinals = [2, 0, 1];
    for (const cardinality of ['set', 'ordered_list'] as const) {
      const result = validateDraft(
        input({
          schema: schema([enumField(cardinality)]),
          values: ordinals.map((ordinal) => value({ ordinal })),
        }),
      );
      expect({ cardinality, findings: result.findings }).toEqual({ cardinality, findings: [] });
    }
  });
});

/**
 * A variant's barcode, against the canonical identifier rules (#367 workstream
 * 7, "validate identifiers and collisions using existing canonical rules").
 *
 * The property under test is NOT "a bad barcode is reported" — that would pass
 * against a validator that reported every barcode. It is the PAIR: a real GTIN
 * of each GS1 length is admitted silently, and the same digits with one changed
 * are refused. Every invalid fixture below is DERIVED from its valid partner by
 * moving exactly one character, so a case cannot pass because the two strings
 * differ in some other way.
 *
 * The valid partners are built with `gs1CheckDigit` — the production routine —
 * rather than pasted, because a hand-typed "valid" GTIN that is not actually
 * valid turns the admission half into a second refusal case and nothing notices.
 */
describe('a barcode is measured against the canonical GTIN rules', () => {
  /** A payload of `length - 1` digits, plus the check digit it really needs. */
  const validGtin = (length: number): string => {
    const payload = Array.from({ length: length - 1 }, (_, index) =>
      String((index * 7) % 10),
    ).join('');
    return `${payload}${gs1CheckDigit(payload)}`;
  };

  /** The same string with its check digit moved by one — nothing else changes. */
  const brokenCheckDigit = (gtin: string): string => {
    const last = Number(gtin.slice(-1));
    return `${gtin.slice(0, -1)}${(last + 1) % 10}`;
  };

  const barcodeCodes = (barcode: string | null): string[] =>
    codes(validateDraft(input({ variants: [variant({ barcode })] })));

  it('admits a real GTIN at every GS1 length and refuses the same digits altered', () => {
    // The four lengths `GTIN_SCHEME_BY_LENGTH` names. Written out rather than
    // read from the map, so a length silently DROPPED from the map is caught
    // here by the admission half going quiet on a case that used to run.
    for (const length of [8, 12, 13, 14]) {
      const good = validGtin(length);
      const bad = brokenCheckDigit(good);
      // The two strings differ in exactly one position. Without this the pair
      // could drift into comparing two unrelated values.
      expect({ length, sameLength: good.length === bad.length }).toEqual({
        length,
        sameLength: true,
      });
      expect({
        length,
        differingChars: [...good].filter((char, index) => char !== bad[index]).length,
      }).toEqual({ length, differingChars: 1 });

      expect({ length, findings: barcodeCodes(good) }).toEqual({ length, findings: [] });
      expect({ length, findings: barcodeCodes(bad) }).toEqual({
        length,
        findings: ['identifier_check_digit_invalid'],
      });
    }
  });

  it('reads separators, so a scanned and a typed spelling of one GTIN agree', () => {
    const good = validGtin(13);
    const spaced = `${good.slice(0, 1)}-${good.slice(1, 7)} ${good.slice(7)}`;
    expect(spaced.replace(/[\s-]/gu, '')).toBe(good);
    expect(barcodeCodes(spaced)).toEqual([]);
  });

  /**
   * The boundary, and it is the half most likely to be "tidied" away later.
   *
   * `catalog_authoring_draft_variants.barcode` is free text behind a non-empty
   * CHECK, and merchants keep other code systems in it. A validator that called
   * those invalid would refuse real data to satisfy a rule nobody wrote — so
   * everything that is not a digit string of a GS1 trade-item length is REPORTED
   * AS NOTHING, deliberately.
   */
  it('says nothing at all about a barcode that is not a GS1 trade-item number', () => {
    for (const barcode of [
      null,
      'ACME-PART-9', // a manufacturer part number
      '12345', // too short to be any GTIN
      '123456789', // nine digits: no GS1 scheme has that length
      '1234567890', // ten: an ISBN-10 length, deliberately NOT inferred
      '123456789012345', // fifteen: past every scheme
      '84000000000O0', // the right length, and an O where a zero should be
    ]) {
      expect({ barcode, findings: barcodeCodes(barcode) }).toEqual({ barcode, findings: [] });
    }
  });

  it('refuses a 13-digit ISBN by its check digit and NOT by its 978 prefix', () => {
    // An ISBN-13 IS an EAN-13. Inferring `isbn13` for a 978/979 prefix would add
    // `not_an_isbn_prefix` to every grocery item; inferring `ean` for all
    // thirteen reaches the identical verdict for a book. Both halves asserted.
    const isbn = '9780306406157'; // a real, valid ISBN-13
    expect(barcodeCodes(isbn)).toEqual([]);
    expect(barcodeCodes(brokenCheckDigit(isbn))).toEqual(['identifier_check_digit_invalid']);
  });

  /**
   * Two variants under one barcode is reported on the SECOND, the
   * `duplicate_variant_sku` shape — one code repeated is one thing to fix.
   */
  it('reports two variants sharing a barcode, and names the SECOND one', () => {
    const gtin = validGtin(13);
    const result = validateDraft(
      input({
        variants: [
          variant({ position: 0, barcode: gtin }),
          variant({ id: 'dv-2', position: 1, axisSignature: 'b'.repeat(64), barcode: gtin }),
        ],
      }),
    );
    const duplicates = result.findings.filter((entry) => entry.code === 'duplicate_variant_barcode');
    // The FIRST occurrence is not the mistake — one finding, on position 1.
    expect(duplicates.map((entry) => ({ severity: entry.severity, path: entry.path }))).toEqual([
      { severity: 'warning', path: 'variants[1].barcode' },
    ]);
    expect(result.publishable).toBe(true);
  });

  /**
   * NEITHER barcode finding may block, and this is the assertion that says so.
   *
   * `AGENTS.md`: "`product_variants.sku` and `.barcode` are unique at NO grain
   * and must not be re-narrowed." An error in the authoring form would re-impose
   * exactly the constraint the schema removed, and for the check digit it would
   * be worse — the column is free text, a thirteen-digit internal article number
   * lives in it legitimately, nothing can tell one from a mistyped EAN, and the
   * cheapest green would be deleting a true value.
   *
   * If either ever escalates, THIS is what has to be changed on purpose.
   */
  it('never blocks publication on a barcode, whatever it says about one', () => {
    const gtin = validGtin(13);
    for (const barcodes of [
      [brokenCheckDigit(gtin), null],
      [gtin, gtin],
      [brokenCheckDigit(gtin), brokenCheckDigit(gtin)],
    ]) {
      const result = validateDraft(
        input({
          variants: barcodes.map((barcode, index) => ({
            id: `dv-${index + 1}`,
            position: index,
            priceAmount: 1_000,
            priceCurrency: 'EUR',
            inventoryAvailable: 1,
            axisSignature: String(index).repeat(64),
            sku: null,
            barcode,
          })),
        }),
      );
      // The finding is PRESENT — without this the case would pass against a
      // validator that had stopped reading barcodes altogether.
      expect({ barcodes, reported: codes(result).length }).not.toEqual({
        barcodes,
        reported: 0,
      });
      expect({ barcodes, publishable: result.publishable }).toEqual({
        barcodes,
        publishable: true,
      });
    }
  });

  it('collides a UPC-12 with the EAN-13 that pads to the same trade item', () => {
    // `036000291452` is a real UPC-A; as a GTIN-14 it is `00036000291452`, and
    // the EAN-13 `0036000291452` pads to the same fourteen digits. Keying the
    // duplicate check on the TYPED string instead of the canonical form would
    // miss exactly this, which is the case that matters — they name one item.
    const upc = '036000291452';
    const ean = '0036000291452';
    expect(codes(validateDraft(input({ variants: [variant({ barcode: upc })] })))).toEqual([]);
    expect(codes(validateDraft(input({ variants: [variant({ barcode: ean })] })))).toEqual([]);

    const result = validateDraft(
      input({
        variants: [
          variant({ position: 0, barcode: upc }),
          variant({
            id: 'dv-2',
            position: 1,
            axisSignature: 'b'.repeat(64),
            barcode: ean,
          }),
        ],
      }),
    );
    expect(codes(result)).toContain('duplicate_variant_barcode');
  });

  it('does not confuse two DIFFERENT barcodes for a duplicate', () => {
    // The positive control for the case above: without it, a duplicate detector
    // that reported every pair of barcodes would pass every assertion here.
    const result = validateDraft(
      input({
        variants: [
          variant({ position: 0, barcode: validGtin(13) }),
          variant({
            id: 'dv-2',
            position: 1,
            axisSignature: 'b'.repeat(64),
            barcode: validGtin(12),
          }),
        ],
      }),
    );
    expect(codes(result)).toEqual([]);
  });
});

/**
 * The LISTING's media, which is not a canonical product fact (#367 workstream
 * 7, "validate media/condition requirements separately from canonical product
 * facts").
 *
 * What is checked is stated as narrowly as it is implemented: presence against
 * a flow, and duplication. Nothing here claims to have seen a file — Mercaria
 * stores bare Oxy ids and holds no credential to read them.
 */
describe('listing media is validated separately from canonical facts', () => {
  const mediaCodes = (imageFileIds: string[], flow: 'merchant' | 'p2p' = 'merchant'): string[] =>
    codes(
      validateDraft(
        // `itemConditionKey` is answered on the p2p path so the case is about
        // MEDIA rather than acquiring `condition_missing` from the same flow.
        input({ imageFileIds, flow, itemConditionKey: flow === 'p2p' ? 'used_good' : null }),
      ),
    );

  it('reports an empty gallery on p2p and stays SILENT on every other flow', () => {
    // The pair is the test. Reporting only the p2p half would pass against a
    // validator that reported an empty gallery on all five flows.
    for (const flow of PRODUCT_TYPE_AUTHORING_FLOWS) {
      const result = validateDraft(input({ imageFileIds: [], flow, itemConditionKey: 'used_good' }));
      const expected = MEDIA_EXPECTED_AUTHORING_FLOWS.includes(flow) ? ['media_missing'] : [];
      expect({ flow, findings: codes(result) }).toEqual({ flow, findings: expected });
    }
    // A vacuity floor on the walk: a tuple that shrank to nothing would make
    // every iteration above assert an empty list and pass.
    expect(PRODUCT_TYPE_AUTHORING_FLOWS.length).toBeGreaterThanOrEqual(5);
    expect(MEDIA_EXPECTED_AUTHORING_FLOWS.length).toBeGreaterThanOrEqual(1);
  });

  it('never blocks publication on media, because no surface can supply a file id', () => {
    // The severity is the decision, not an incidental. There is no upload path
    // to Oxy's file service anywhere in this repository, so an error would be a
    // gate with no reachable green. If a picker ever lands and this escalates,
    // THIS is the assertion that has to be changed on purpose.
    const result = validateDraft(
      input({ imageFileIds: [], flow: 'p2p', itemConditionKey: 'used_good' }),
    );
    expect(result.findings.filter((entry) => entry.code === 'media_missing')).toEqual([
      { code: 'media_missing', severity: 'warning', path: 'listing.imageFileIds' },
    ]);
    expect(result.publishable).toBe(true);
  });

  it('reports a repeated file at its own gallery position, second occurrence only', () => {
    const result = validateDraft(input({ imageFileIds: ['a', 'b', 'a', 'c', 'a'] }));
    expect(
      result.findings
        .filter((entry) => entry.code === 'duplicate_media_file')
        .map((entry) => ({ severity: entry.severity, path: entry.path })),
    ).toEqual([
      { severity: 'warning', path: 'listing.imageFileIds[2]' },
      { severity: 'warning', path: 'listing.imageFileIds[4]' },
    ]);
    expect(result.publishable).toBe(true);
  });

  it('says nothing about a gallery whose files are all different', () => {
    // The positive control for the case above.
    expect(mediaCodes(['a', 'b', 'c'])).toEqual([]);
  });

  it('does NOT case-fold a file id, because it is a foreign service key', () => {
    // A SKU is folded — every rail looks one up case-insensitively. An Oxy file
    // id is another service's primary key, and folding it would declare two
    // distinct files the same. The inverse of `duplicate_variant_sku`'s rule,
    // and the two are next to each other in the source, so this pins which is
    // which.
    expect(mediaCodes(['File-A', 'file-a'])).toEqual([]);
    expect(mediaCodes(['file-a', 'file-a'])).toEqual(['duplicate_media_file']);
  });

  it('reads a gallery of 64 files without complaining about its size', () => {
    // No COUNT ceiling is enforced here and the absence is deliberate:
    // `catalog-authoring-schemas.ts` bounds the array at 64 on the only route
    // that writes it, so a ceiling in this module could not fire. A test that
    // asserted one would be asserting a branch nothing reaches.
    const gallery = Array.from({ length: 64 }, (_, index) => `file-${index}`);
    expect(mediaCodes(gallery)).toEqual([]);
  });
});

/**
 * The two flow tuples agree TODAY, and a change to either is a decision.
 *
 * They are separate constants because they could legitimately diverge — and
 * because they carry different SEVERITIES, which is the divergence that already
 * exists. What must not happen quietly is the MEMBERSHIP drifting apart, since
 * the media expectation's whole justification is #90's condition evidence
 * coming from the listing's own gallery: a flow that owes a condition and not a
 * photograph has broken that argument and owes a new one.
 */
describe('the media and condition flow tuples are pinned against each other', () => {
  it('names the same flows, and both are subsets of the flow vocabulary', () => {
    expect([...MEDIA_EXPECTED_AUTHORING_FLOWS].sort()).toEqual(
      [...CONDITION_REQUIRED_AUTHORING_FLOWS].sort(),
    );
    for (const flow of MEDIA_EXPECTED_AUTHORING_FLOWS) {
      expect(PRODUCT_TYPE_AUTHORING_FLOWS).toContain(flow);
    }
    // Neither may be empty: an empty tuple makes both rules unreachable while
    // every assertion about them goes on passing.
    expect(MEDIA_EXPECTED_AUTHORING_FLOWS.length).toBeGreaterThanOrEqual(1);
  });
});
