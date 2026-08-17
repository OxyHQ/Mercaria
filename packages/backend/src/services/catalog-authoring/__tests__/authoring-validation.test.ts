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
  AttributeComponentAxis,
  AuthoringField,
  AuthoringSchema,
  AuthoringValidationCode,
} from '@mercaria/shared-types';
import {
  AUTHORING_VALIDATION_CODES,
  PRODUCT_TYPE_AUTHORING_FLOWS,
} from '@mercaria/shared-types';
import {
  AUTHORING_DEFAULT_MERCHANT_CONDITION,
  CONDITION_REQUIRED_AUTHORING_FLOWS,
} from '../../../db/schema/catalogAuthoring.js';
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
    variants: [variant()],
    values: [value()],
    categorySelectable: true,
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
    };

    const missing = AUTHORING_VALIDATION_CODES.filter(
      (code) => !produced.has(code) && EXEMPT[code] === undefined,
    );
    expect(missing, 'these codes are in the closed set and nothing produces them').toEqual([]);

    // The exemption list needs its own exact-count assertion, or it is a hole
    // that widens one green build at a time.
    expect(Object.keys(EXEMPT)).toHaveLength(2);
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
