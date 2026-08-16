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
import type {
  AttributeComponentAxis,
  AuthoringField,
  AuthoringSchema,
  AuthoringValidationCode,
} from '@mercaria/shared-types';
import { AUTHORING_VALIDATION_CODES } from '@mercaria/shared-types';
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
});
