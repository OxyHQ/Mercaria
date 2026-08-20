/**
 * Bulk editing the matrix (#367 step 10).
 *
 * ## The case this file exists for
 *
 * The acceptance box asks for "bulk edit for SKU, barcode, price, stock, media
 * and availability". A literal apply-to-all for SKU would satisfy those words
 * and be wrong: it writes one code across every variant, which defeats what a
 * SKU is, and **the database will not refuse it** — `product_variants.sku` is
 * unique at no grain, deliberately (#296).
 *
 * That makes distinctness a property nothing downstream can check. It is not
 * enforced by a constraint, it is not visible in a type, and a screenshot of
 * the feature working looks identical either way. So it is asserted here, and
 * the assertion is the reason this module is a pair of differently-shaped
 * functions rather than one `applyToAll(field, value)`.
 *
 * ## Barcode is asserted to behave the OPPOSITE way, on purpose
 *
 * Two rows sharing a GTIN is legitimate and is the premise the canonical
 * catalogue rests on. Pinning that explicitly is what stops somebody "fixing
 * the inconsistency" later by making barcode generate distinct values too.
 */

import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@mercaria/shared-types';

import { applyBarcodeToAll, applySkuPrefix, setAllSold } from '../bulk';
import { nextRowKey, type VariantRow } from '../matrix';

const CURRENCY: CurrencyCode = 'EUR';

function row(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    key: nextRowKey(),
    axes: {},
    enabled: true,
    sku: '',
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

describe('applySkuPrefix gives every sold row a DISTINCT code', () => {
  /**
   * The load-bearing assertion. A mutation to `{ ...row, sku: trimmed }` — the
   * apply-to-all the box's wording invites — turns this red and nothing else in
   * the repository would notice.
   */
  it('never writes one SKU across several rows', () => {
    const result = applySkuPrefix([row(), row(), row()], 'ABC');
    const codes = result.map((entry) => entry.sku);

    expect(new Set(codes).size).toBe(3);
    // And the control: it did something at all. `new Set([]).size === 0` and
    // three untouched empty strings collapse to a set of ONE, so the assertion
    // above already discriminates — this names the actual shape.
    expect(codes).toEqual(['ABC-1', 'ABC-2', 'ABC-3']);
  });

  /**
   * Numbering follows the SENT order. A disabled row takes no position, so the
   * sequence has no gaps — the same rule `enabledVariantPayloads` applies when
   * it closes the gap rather than leaving a hole.
   */
  it('numbers by sent position and skips a row that is not sold', () => {
    const result = applySkuPrefix(
      [row(), row({ enabled: false, sku: 'UNTOUCHED' }), row()],
      'ABC',
    );

    expect(result.map((entry) => entry.sku)).toEqual(['ABC-1', 'UNTOUCHED', 'ABC-2']);
  });

  /**
   * A blank prefix is a no-op, not a clear. The author pressed "apply" with an
   * empty box; erasing every SKU in the matrix is not what that means, and it
   * is unrecoverable in one keystroke.
   */
  it('leaves every SKU alone when the prefix is blank', () => {
    const before = [row({ sku: 'KEEP-1' }), row({ sku: 'KEEP-2' })];

    expect(applySkuPrefix(before, '   ').map((entry) => entry.sku)).toEqual(['KEEP-1', 'KEEP-2']);
  });

  it('trims the prefix rather than embedding the whitespace', () => {
    expect(applySkuPrefix([row()], '  ABC  ')[0]?.sku).toBe('ABC-1');
  });
});

describe('applyBarcodeToAll deliberately DOES share one value', () => {
  /**
   * The opposite of the SKU rule, pinned so it is not "made consistent" later.
   * A GTIN identifies a trade item; rows of one product legitimately share one.
   */
  it('writes the same barcode to every sold row', () => {
    const result = applyBarcodeToAll([row(), row(), row()], '5012345678900');

    expect(result.map((entry) => entry.barcode)).toEqual([
      '5012345678900',
      '5012345678900',
      '5012345678900',
    ]);
  });

  it('leaves a row that is not sold untouched', () => {
    const result = applyBarcodeToAll(
      [row(), row({ enabled: false, barcode: 'UNTOUCHED' })],
      '5012345678900',
    );

    expect(result[1]?.barcode).toBe('UNTOUCHED');
    // The control: the sold row DID change, so the assertion above is not
    // passing against a function that writes nothing.
    expect(result[0]?.barcode).toBe('5012345678900');
  });

  it('leaves every barcode alone when the value is blank', () => {
    const before = [row({ barcode: 'KEEP' })];

    expect(applyBarcodeToAll(before, '  ').map((entry) => entry.barcode)).toEqual(['KEEP']);
  });
});

describe('setAllSold keeps every row', () => {
  /**
   * The bulk form of the `sold` switch. Rows are kept either way: the point of
   * that switch is that an excluded combination stays visible, so a bulk
   * version that deleted rows would be a different and destructive feature
   * wearing the same label.
   */
  it('marks none sold without removing anything', () => {
    const result = setAllSold([row(), row(), row()], false);

    expect(result).toHaveLength(3);
    expect(result.every((entry) => !entry.enabled)).toBe(true);
  });

  it('marks every row sold, including one that was excluded', () => {
    const result = setAllSold([row(), row({ enabled: false })], true);

    expect(result.every((entry) => entry.enabled)).toBe(true);
    expect(result).toHaveLength(2);
  });

  /**
   * A row already in the requested state is returned BY IDENTITY, not rebuilt.
   * React keys the row inputs on `row.key`, and replacing an object the author
   * is typing in remounts the control under their cursor.
   */
  it('returns an unchanged row by identity', () => {
    const untouched = row();
    const result = setAllSold([untouched, row({ enabled: false })], true);

    expect(result[0]).toBe(untouched);
    // The control: the row that DID change is a new object.
    expect(result[1]).not.toBe(untouched);
  });
});
