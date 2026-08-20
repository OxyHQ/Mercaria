/**
 * The client half of the server's variant bound (#367, ADR 0007 D6).
 *
 * ## Two pins for one bound, deliberately
 *
 * `patchProductDraftSchema` caps `variants` at 200
 * (`packages/backend/src/middleware/catalog-authoring-schemas.ts`), pinned by
 * `middleware/__tests__/catalog-authoring-bounds.test.ts`. `MAX_MATRIX_ROWS`
 * here is the same number on the generating side, and it is pinned separately
 * rather than shared or imported.
 *
 * That is not duplication for its own sake. A dashboard test cannot import the
 * backend: this package is `strict: true` and that one is `strict: false`, so
 * the import would compile a module under the wrong compiler settings — the
 * measured reason `vitest.config.ts` gives for this runner existing at all. And
 * a shared constant would not help anyway, because the two numbers are not the
 * same fact: one is what the server will ACCEPT, the other is what the client
 * will GENERATE, and the invariant between them is an inequality
 * (`MAX_MATRIX_ROWS <= the server's cap`) rather than an equality.
 *
 * Both directions of a divergence are a real defect, and each pin is red for its
 * own side:
 *
 *   - the client raised above the server's cap: the wizard generates a matrix
 *     and the save it just invited fails with a 400 naming an array length,
 *     after the author has priced every row;
 *   - the server lowered under the client: identical symptom, opposite cause.
 *
 * ## Why the truncation behaviour is pinned and not only the number
 *
 * A constant nothing reads is worth nothing. `generateMatrix` REFUSES above the
 * cap — it returns the existing rows untouched and says `truncated: true` —
 * rather than generating the first 200 of 400. Both halves matter and the file
 * asserts them separately: silently truncating produces a matrix missing exactly
 * the combinations nobody looked at, and returning fresh rows would discard
 * every price and SKU the author had already typed.
 */

import { describe, expect, it } from 'vitest';
import type {
  AuthoringField,
  AuthoringSchema,
  CurrencyCode,
} from '@mercaria/shared-types';

import {
  MAX_MATRIX_ROWS,
  controlledValueStrings,
  generateMatrix,
  nextRowKey,
  type MatrixAxis,
  type VariantRow,
} from '../matrix';
import { fieldsByKey } from '../wizard-state';

const CURRENCY: CurrencyCode = 'EUR';

function axisField(key: string, valueIds: readonly string[]): AuthoringField {
  return {
    id: `field-${key}`,
    key,
    attributeDefinitionId: `def-${key}`,
    attributeVersion: 1,
    scope: 'variant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: true,
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
    controlledValues: valueIds.map((id, position) => ({ id, value: id, position })),
  };
}

/** Two axes whose value counts multiply to exactly `total`. */
function axesMultiplyingTo(left: number, right: number): {
  readonly axes: readonly MatrixAxis[];
  readonly schema: AuthoringSchema;
} {
  const leftIds = Array.from({ length: left }, (_unused, index) => `l-${String(index)}`);
  const rightIds = Array.from({ length: right }, (_unused, index) => `r-${String(index)}`);
  const fields = [axisField('axis_left', leftIds), axisField('axis_right', rightIds)];

  const schema = {
    contractVersion: 1,
    productType: {
      definitionId: 'ptype-1',
      key: 'ptype',
      version: 1,
      lifecycle: 'published',
      pendingProposalPolicy: 'block',
    },
    categoryId: 'cat-1',
    flow: 'guided',
    market: 'ES',
    locale: { requested: 'en', resolved: 'en', fallbackChain: ['en'] },
    permissions: {
      canEditDraft: true,
      canPublish: true,
      canProposeValues: false,
      canSelectCanonicalEntity: false,
    },
    steps: [],
    groups: [],
    fields,
    text: { groups: {}, fields: {}, values: {} },
    etag: 'etag-1',
  } as unknown as AuthoringSchema;

  const axes: MatrixAxis[] = [
    {
      attributeKey: 'axis_left',
      values: leftIds.map((id) => ({ kind: 'controlled_value' as const, ordinal: 0, enumValueId: id })),
    },
    {
      attributeKey: 'axis_right',
      values: rightIds.map((id) => ({ kind: 'controlled_value' as const, ordinal: 0, enumValueId: id })),
    },
  ];

  return { axes, schema };
}

function generate(left: number, right: number, existing: readonly VariantRow[] = []) {
  const { axes, schema } = axesMultiplyingTo(left, right);
  return generateMatrix(axes, {
    currency: CURRENCY,
    existing,
    fieldsByKey: fieldsByKey(schema),
    valueStringById: controlledValueStrings(schema),
  });
}

describe('MAX_MATRIX_ROWS is the client half of the server cap', () => {
  /**
   * The pin. `patchProductDraftSchema` caps `variants` at 200; generating more
   * than the server accepts means inviting a save that cannot succeed.
   */
  it('is 200 — the same bound patchProductDraftSchema accepts', () => {
    expect(MAX_MATRIX_ROWS).toBe(200);
  });

  it('generates the full product at exactly the cap', () => {
    const { rows, truncated } = generate(20, 10);

    expect(truncated).toBe(false);
    expect(rows).toHaveLength(MAX_MATRIX_ROWS);
  });

  /**
   * One above. The control for the case above and the real assertion in its own
   * right: with the bound check deleted this generates 201 rows and reports
   * `truncated: false`, so the wizard prices a matrix the server will refuse.
   */
  it('refuses one above the cap rather than truncating to it', () => {
    const existing: readonly VariantRow[] = [
      {
        key: nextRowKey(),
        axes: {},
        enabled: true,
        sku: 'ALREADY-TYPED',
        barcode: '',
        priceMajor: '42.00',
        compareAtMajor: '',
        currency: CURRENCY,
        inventoryTracked: true,
        inventoryAvailable: '7',
        selectedCanonicalVariantId: null,
      },
    ];

    const { rows, truncated } = generate(201, 1, existing);

    expect(truncated).toBe(true);
    // Not the first 200 of 201 — a truncated matrix is missing exactly the
    // combinations nobody looked at.
    expect(rows).toHaveLength(1);
    // And the author's own work is handed back untouched rather than replaced.
    expect(rows[0]?.sku).toBe('ALREADY-TYPED');
    expect(rows[0]?.priceMajor).toBe('42.00');
  });
});
