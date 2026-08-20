/**
 * A variant a merchant switched OFF is never published (#367, ADR 0007 D6).
 *
 * ## Why this file exists at all
 *
 * The mechanism was complete and ungated. `VariantRows.tsx` has the `sold`
 * switch driving `row.enabled`, a disabled row stays on screen so the author
 * can see what they excluded, and five modules exclude it — `matrix.ts` twice,
 * `wizard-state.ts` three times. Every one of those is a bare
 * `.filter((row) => row.enabled)` or `if (!row.enabled) continue;`.
 *
 * Measured on `origin/main` before this file: `enabled: false` appeared **zero**
 * times across `packages/dashboard` and the backend suite, against a control of
 * `enabled: true` at three occurrences in two files (`matrix.ts`,
 * `wizard-state.ts`) — both of which only ever CONSTRUCT an enabled row.
 * Nothing anywhere constructed a disabled one, so no test could observe the
 * exclusion, and deleting any of the five filters left the whole repository
 * green while publishing combinations a merchant had switched off.
 *
 * The SELECTION half was already gated end to end
 * (`vertical-matrix-and-new-product.e2e.realdb.test.ts` publishes eight
 * configurations and counts eight variants, links, signatures and offers). This
 * is the EXCLUSION half, which that file cannot see: every row it authors is
 * enabled, so an excluded row and a mechanism that ignores exclusions produce
 * the same eight.
 *
 * ## What each case would report if its mechanism were absent
 *
 * Every case below names the exact line it defends and was confirmed RED
 * against a tree with that line deleted — the results are recorded in the PR.
 * Each also carries a POSITIVE CONTROL in the same `it`, because the dangerous
 * direction is an assertion that passes on an empty result: "the disabled row's
 * SKU is absent" is satisfied by a payload of nothing at all, so every absence
 * claim here is paired with the presence of its enabled sibling.
 *
 * ## The one thing this file deliberately does NOT claim
 *
 * A disabled row is not PERSISTED. It has no payload, so on reload
 * `hydrateForm` rebuilds every stored variant with `enabled: true` — the
 * exclusion survives the save as an ABSENCE, not as a stored flag. That is the
 * design (D6: nothing generates the full product as rows), and stating it here
 * stops a later reader adding a "the toggle survives a reload" case that could
 * only ever pass by inventing a column.
 */

import { describe, expect, it } from 'vitest';
import type {
  AuthoringField,
  AuthoringSchema,
  CurrencyCode,
} from '@mercaria/shared-types';

import {
  axisDedupeKey,
  controlledValueStrings,
  duplicateRowKeys,
  enabledVariantPayloads,
  generateMatrix,
  nextRowKey,
  type VariantRow,
} from '../matrix';
import { composePatch, fieldsByKey, formSignature, stepCompleteness } from '../wizard-state';
import type { WizardFormState } from '../wizard-state';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const CURRENCY: CurrencyCode = 'EUR';

/**
 * A variant-capable enum field.
 *
 * The keys and value ids here are arbitrary and local to this file. That is
 * safe rather than a wall-1 violation: `validate-authoring-schema-driven.mjs`
 * skips every `__tests__/` path deliberately (#469), because naming specific
 * values is exactly what a test does and what production code must not.
 */
function axisField(key: string, valueIds: readonly string[]): AuthoringField {
  return {
    id: `field-${key}`,
    key,
    attributeDefinitionId: `def-${key}`,
    attributeVersion: 1,
    scope: 'variant',
    requirement: 'required',
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

const COLOUR = axisField('axis-one', ['val-a', 'val-b']);
const SIZE = axisField('axis-two', ['val-s', 'val-m']);

function schemaWith(fields: readonly AuthoringField[]): AuthoringSchema {
  return {
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
}

const SCHEMA = schemaWith([COLOUR, SIZE]);

/** One row, enabled unless told otherwise, carrying a SKU that names it. */
function row(
  sku: string,
  axes: Readonly<Record<string, string>>,
  overrides: Partial<VariantRow> = {},
): VariantRow {
  const entries: Record<string, readonly { kind: 'controlled_value'; ordinal: number; enumValueId: string }[]> =
    {};
  for (const [key, valueId] of Object.entries(axes)) {
    entries[key] = [{ kind: 'controlled_value', ordinal: 0, enumValueId: valueId }];
  }
  return {
    key: nextRowKey(),
    axes: entries,
    enabled: true,
    sku,
    barcode: '',
    priceMajor: '10.00',
    compareAtMajor: '',
    currency: CURRENCY,
    inventoryTracked: true,
    inventoryAvailable: '5',
    selectedCanonicalVariantId: null,
    ...overrides,
  };
}

function formWith(rows: readonly VariantRow[]): WizardFormState {
  return {
    // Left empty deliberately: `validate:i18n-strings` flags ANY string literal
    // in a `title:`/`description:` property, test files included, and neither is
    // load-bearing for anything this file asserts.
    title: '',
    description: '',
    tags: [],
    selectedCanonicalProductId: null,
    productEntries: {},
    axes: [],
    rows,
  } as unknown as WizardFormState;
}

/** Every SKU a payload set carries, so absence and presence are both readable. */
function skus(payloads: readonly { readonly sku?: string }[]): readonly (string | undefined)[] {
  return payloads.map((payload) => payload.sku);
}

/* -------------------------------------------------------------------------- */
/* matrix.ts — the payload                                                     */
/* -------------------------------------------------------------------------- */

describe('enabledVariantPayloads omits what the merchant switched off', () => {
  /** Defends `matrix.ts`'s `if (!row.enabled) continue;` in enabledVariantPayloads. */
  it('drops a disabled row and keeps its enabled sibling', () => {
    const payloads = enabledVariantPayloads(
      [
        row('SOLD-A', { [COLOUR.key]: 'val-a' }),
        row('EXCLUDED-B', { [COLOUR.key]: 'val-b' }, { enabled: false }),
      ],
      fieldsByKey(SCHEMA),
    );

    // The absence claim.
    expect(skus(payloads)).not.toContain('EXCLUDED-B');
    // The positive control: an empty payload set would satisfy the line above.
    expect(skus(payloads)).toContain('SOLD-A');
    expect(payloads).toHaveLength(1);
  });

  /**
   * The strongest form of the claim, and the one that names the damage.
   *
   * With the filter deleted this returns the WHOLE matrix — four combinations a
   * merchant explicitly said they do not sell — rather than nothing.
   */
  it('sends nothing at all when every combination is switched off', () => {
    const all = [
      row('A-S', { [COLOUR.key]: 'val-a', [SIZE.key]: 'val-s' }, { enabled: false }),
      row('A-M', { [COLOUR.key]: 'val-a', [SIZE.key]: 'val-m' }, { enabled: false }),
      row('B-S', { [COLOUR.key]: 'val-b', [SIZE.key]: 'val-s' }, { enabled: false }),
      row('B-M', { [COLOUR.key]: 'val-b', [SIZE.key]: 'val-m' }, { enabled: false }),
    ];

    // The control that makes the emptiness a CHANGE rather than a standing fact:
    // the same four rows, enabled, are all published.
    const enabled = all.map((entry) => ({ ...entry, enabled: true }));
    expect(enabledVariantPayloads(enabled, fieldsByKey(SCHEMA))).toHaveLength(4);

    expect(enabledVariantPayloads(all, fieldsByKey(SCHEMA))).toHaveLength(0);
  });

  /**
   * The server keys a variant on its POSITION in the array, so the excluded row
   * must not leave a hole or shift its siblings' meaning. A disabled row in the
   * MIDDLE is the case that separates "filtered" from "blanked".
   */
  it('closes the gap rather than leaving a hole when the exclusion is in the middle', () => {
    const payloads = enabledVariantPayloads(
      [
        row('FIRST', { [COLOUR.key]: 'val-a' }),
        row('EXCLUDED', { [COLOUR.key]: 'val-b' }, { enabled: false }),
        row('SECOND', { [SIZE.key]: 'val-s' }),
      ],
      fieldsByKey(SCHEMA),
    );

    expect(skus(payloads)).toEqual(['FIRST', 'SECOND']);
  });
});

/* -------------------------------------------------------------------------- */
/* matrix.ts — duplicate detection                                             */
/* -------------------------------------------------------------------------- */

describe('duplicateRowKeys ignores rows that are not sold', () => {
  /**
   * Defends `matrix.ts`'s `if (!row.enabled) continue;` in duplicateRowKeys.
   *
   * A disabled row is never sent, so it cannot collide with anything at the
   * server's partial unique. Counting it would block a publish on a conflict
   * that does not exist — and the author's remedy (delete the row) is the one
   * thing the "keep it visible so you can see what you excluded" design exists
   * to avoid making necessary.
   */
  it('does not report a duplicate against a disabled twin', () => {
    const enabled = row('SOLD', { [COLOUR.key]: 'val-a' });
    const disabledTwin = row('EXCLUDED', { [COLOUR.key]: 'val-a' }, { enabled: false });

    const duplicates = duplicateRowKeys(
      [enabled, disabledTwin],
      fieldsByKey(SCHEMA),
      controlledValueStrings(SCHEMA),
    );

    expect(duplicates.size).toBe(0);
  });

  /**
   * The positive control for the case above, in its own right: two ENABLED
   * twins DO collide. Without this, the case above passes against a function
   * that returns an empty set unconditionally.
   */
  it('still reports a duplicate between two rows that are both sold', () => {
    const first = row('SOLD-1', { [COLOUR.key]: 'val-a' });
    const second = row('SOLD-2', { [COLOUR.key]: 'val-a' });

    const duplicates = duplicateRowKeys(
      [first, second],
      fieldsByKey(SCHEMA),
      controlledValueStrings(SCHEMA),
    );

    // The SECOND is reported, never the first — the author is told which row to
    // remove rather than left choosing between two.
    expect([...duplicates]).toEqual([second.key]);
  });
});

/* -------------------------------------------------------------------------- */
/* matrix.ts — regeneration                                                    */
/* -------------------------------------------------------------------------- */

describe('regenerating the matrix preserves what the author excluded', () => {
  /**
   * Defends `generateMatrix`'s `{ ...previous, axes: axesForRow }`.
   *
   * Adding one value to one axis regenerates every row. The row is matched on
   * its dedupe key, which is stable, so `enabled` rides along with the price
   * and the SKU. Spelling it `{ ...singleVariantRow(), axes }` for a matched row
   * — or dropping `enabled` from the spread — silently re-enables every
   * combination the merchant switched off, on a keystroke they did not connect
   * to it.
   */
  it('keeps a combination disabled after a second axis value is added', () => {
    const existing = [
      row('A-S', { [COLOUR.key]: 'val-a', [SIZE.key]: 'val-s' }),
      row('B-S', { [COLOUR.key]: 'val-b', [SIZE.key]: 'val-s' }, { enabled: false }),
    ];

    const { rows, truncated } = generateMatrix(
      [
        {
          attributeKey: COLOUR.key,
          values: [
            { kind: 'controlled_value', ordinal: 0, enumValueId: 'val-a' },
            { kind: 'controlled_value', ordinal: 0, enumValueId: 'val-b' },
          ],
        },
        {
          attributeKey: SIZE.key,
          values: [
            { kind: 'controlled_value', ordinal: 0, enumValueId: 'val-s' },
            { kind: 'controlled_value', ordinal: 0, enumValueId: 'val-m' },
          ],
        },
      ],
      {
        currency: CURRENCY,
        existing,
        fieldsByKey: fieldsByKey(SCHEMA),
        valueStringById: controlledValueStrings(SCHEMA),
      },
    );

    expect(truncated).toBe(false);
    expect(rows).toHaveLength(4);

    const byKey = new Map(
      rows.map((entry) => [
        axisDedupeKey(entry.axes, fieldsByKey(SCHEMA), controlledValueStrings(SCHEMA)),
        entry,
      ]),
    );
    const excludedKey = axisDedupeKey(
      existing[1].axes,
      fieldsByKey(SCHEMA),
      controlledValueStrings(SCHEMA),
    );
    const keptKey = axisDedupeKey(
      existing[0].axes,
      fieldsByKey(SCHEMA),
      controlledValueStrings(SCHEMA),
    );

    // The exclusion survived the regeneration...
    expect(byKey.get(excludedKey)?.enabled).toBe(false);
    // ...and the control: the row that was NOT excluded is still sold, so the
    // assertion above is not passing because everything came back disabled.
    expect(byKey.get(keptKey)?.enabled).toBe(true);
    // The two combinations that are genuinely new default to sold.
    expect(rows.filter((entry) => entry.enabled)).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* wizard-state.ts — the save body                                             */
/* -------------------------------------------------------------------------- */

describe('composePatch — the body a save actually sends', () => {
  /**
   * The claim at the grain that leaves the app. `enabledVariantPayloads` being
   * correct is necessary and not sufficient: `composePatch` is what the autosave
   * PUTs, and a future caller composing `variants` from `form.rows` directly
   * would bypass the filter entirely while every case above stayed green.
   */
  it('never carries a switched-off combination in `variants`', () => {
    const patch = composePatch(
      formWith([
        row('SOLD', { [COLOUR.key]: 'val-a' }),
        row('EXCLUDED', { [COLOUR.key]: 'val-b' }, { enabled: false }),
      ]),
      SCHEMA,
      3,
    );

    expect(skus(patch.variants ?? [])).toEqual(['SOLD']);
    // The patch is otherwise a real one — the assertion above is not passing
    // against a body that failed to compose at all.
    expect(patch.version).toBe(3);
    expect(Array.isArray(patch.fields)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* wizard-state.ts — completeness                                              */
/* -------------------------------------------------------------------------- */

describe('a switched-off combination cannot block a publish', () => {
  /**
   * Defends `variantsCompleteness`'s `form.rows.filter((row) => row.enabled)`.
   *
   * A disabled row with no answer on a required axis is exactly what an
   * "impossible combination" looks like — the author switched it off BECAUSE it
   * has no coherent value. Counting it makes the step permanently blocked and
   * the only remedy is to delete the row, which is the affordance the disabled
   * state exists to replace.
   */
  it('does not count a disabled row missing a required axis as blocking', () => {
    const complete = stepCompleteness(
      'variants',
      formWith([
        row('SOLD', { [COLOUR.key]: 'val-a', [SIZE.key]: 'val-s' }),
        row('EXCLUDED', {}, { enabled: false }),
      ]),
      SCHEMA,
    );

    expect(complete.blocked).toBe(0);
    expect(complete.total).toBe(1);

    // The control: the SAME row, enabled, DOES block. Without this the
    // assertion above passes against a function that never blocks anything.
    const blocked = stepCompleteness(
      'variants',
      formWith([
        row('SOLD', { [COLOUR.key]: 'val-a', [SIZE.key]: 'val-s' }),
        row('NOW-SOLD', {}),
      ]),
      SCHEMA,
    );
    expect(blocked.blocked).toBeGreaterThan(0);
  });

  /** Defends `pricingCompleteness`'s own `.filter((row) => row.enabled)`. */
  it('does not count a disabled row with no price as blocking', () => {
    const complete = stepCompleteness(
      'pricing',
      formWith([
        row('SOLD', { [COLOUR.key]: 'val-a' }),
        row('EXCLUDED', { [COLOUR.key]: 'val-b' }, { enabled: false, priceMajor: '' }),
      ]),
      SCHEMA,
    );

    expect(complete.blocked).toBe(0);
    expect(complete.answered).toBe(1);
    expect(complete.total).toBe(1);

    // The control: an ENABLED row with no price blocks.
    const blocked = stepCompleteness(
      'pricing',
      formWith([
        row('SOLD', { [COLOUR.key]: 'val-a' }),
        row('UNPRICED', { [COLOUR.key]: 'val-b' }, { priceMajor: '' }),
      ]),
      SCHEMA,
    );
    expect(blocked.blocked).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* wizard-state.ts — change detection                                          */
/* -------------------------------------------------------------------------- */

describe('formSignature ignores a row nothing will send', () => {
  /**
   * Defends `formSignature`'s `.filter((row) => row.enabled)` — and it is the
   * ONE assertion in this file sensitive to that line alone.
   *
   * Editing a disabled row's axes changes nothing about the patch (the row has
   * no payload), so if the signature moved, every keystroke inside an excluded
   * row would cost an autosave request that sends a byte-identical body.
   */
  it('does not change when a disabled row\'s axes are edited', () => {
    const sold = row('SOLD', { [COLOUR.key]: 'val-a' });
    const before = row('EXCLUDED', { [COLOUR.key]: 'val-b' }, { enabled: false });
    const after = { ...before, axes: { [COLOUR.key]: [{ kind: 'controlled_value' as const, ordinal: 0, enumValueId: 'val-a' }] } };

    expect(formSignature(formWith([sold, after]), SCHEMA, 1)).toBe(
      formSignature(formWith([sold, before]), SCHEMA, 1),
    );

    // The control: editing an ENABLED row's axes DOES change the signature, so
    // the equality above is not passing against a constant.
    const editedSold = {
      ...sold,
      axes: { [COLOUR.key]: [{ kind: 'controlled_value' as const, ordinal: 0, enumValueId: 'val-b' }] },
    };
    expect(formSignature(formWith([editedSold, before]), SCHEMA, 1)).not.toBe(
      formSignature(formWith([sold, before]), SCHEMA, 1),
    );
  });

  /**
   * Toggling a row OFF is a real change and must cost a save — that is the
   * request that removes the variant from the draft on the server. The case
   * above must not be satisfied by a signature that ignores `enabled` entirely.
   */
  it('does change when a row is switched off', () => {
    const sold = row('SOLD', { [COLOUR.key]: 'val-a' });
    const second = row('SECOND', { [COLOUR.key]: 'val-b' });

    expect(formSignature(formWith([sold, { ...second, enabled: false }]), SCHEMA, 1)).not.toBe(
      formSignature(formWith([sold, second]), SCHEMA, 1),
    );
  });
});
