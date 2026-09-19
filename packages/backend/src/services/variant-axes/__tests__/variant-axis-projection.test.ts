/**
 * Projecting a listing's options from the TYPED axes (#367 line 324).
 *
 * The property under test is the one line 324 names: a shopper's option list
 * can come from `native_listing_variant_axes` instead of from
 * `listing_options`, and a listing that has no typed axes still renders. Each
 * case below is a way that could be true by accident — a projector returning
 * the legacy shape unchanged would pass a naive assertion perfectly, so every
 * case here names a fact only the TYPED rows carry (the registry label rather
 * than the seller's word) or a shape the legacy path cannot produce.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyVariantAxisShadow,
  projectTypedListingAxes,
  type ProjectedVariantOptionValue,
} from '../projection.js';
import type {
  NativeVariantAxisAssignmentRow,
  NativeVariantAxisWithLabel,
} from '../../../db/variantAxes/variantAxisRepository.js';

const LISTING = 'lst_1';

function axis(
  attributeKey: string,
  label: string,
  position: number,
  legacyOptionName: string | null = null,
): NativeVariantAxisWithLabel {
  return {
    id: `axis_${attributeKey}`,
    listingId: LISTING,
    attributeKey,
    attributeDefinitionId: `def_${attributeKey}`,
    attributeDefinitionVersion: 1,
    label,
    legacyOptionName,
    position,
  };
}

function assignment(
  variantId: string,
  attributeKey: string,
  displayValue: string,
): NativeVariantAxisAssignmentRow {
  return {
    id: `asg_${variantId}_${attributeKey}`,
    variantId,
    axisId: `axis_${attributeKey}`,
    attributeDefinitionId: `def_${attributeKey}`,
    attributeKey,
    displayValue,
    normalizedValue: displayValue.toLowerCase(),
    enumValueId: null,
    normalizedNumber: null,
    normalizedUnit: null,
    sourceClaimId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as NativeVariantAxisAssignmentRow;
}

describe('projectTypedListingAxes', () => {
  it('answers null when the listing declares no typed axis', () => {
    // The FALLBACK case, and it is the whole catalogue today. `null` is what
    // makes the caller serve legacy, so this is the assertion that keeps an
    // un-migrated listing rendering at all.
    expect(projectTypedListingAxes([], [], ['v1'])).toBeNull();
  });

  it('renders the axis name from the REGISTRY label, not the legacy option name', () => {
    // The one assertion that cannot pass against the legacy path. The seller's
    // word was `Colour`; the definition's label is `Color`. Serving the stored
    // legacy name would reproduce the exact defect ADR 0007 D6 removes, so the
    // legacy spelling is asserted ABSENT rather than merely not-expected.
    const projected = projectTypedListingAxes(
      [axis('color', 'Color', 0, 'Colour')],
      [assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(projected?.options).toEqual([{ name: 'Color', values: ['Ice'] }]);
    expect(projected?.valuesByVariant.get('v1')).toEqual([{ name: 'Color', value: 'Ice' }]);
    expect(JSON.stringify(projected)).not.toContain('Colour');
  });

  it('keeps two axes that share a LABEL apart', () => {
    // The bug this case exists for: bucketing values by label folds two
    // dimensions into one option and renders a listing that varies along two as
    // though it varied along one. Unique-per-listing is the KEY, never the word.
    const projected = projectTypedListingAxes(
      [axis('phone_color', 'Color', 0), axis('case_color', 'Color', 1)],
      [
        assignment('v1', 'phone_color', 'Black'),
        assignment('v1', 'case_color', 'Clear'),
      ],
      ['v1'],
    );
    expect(projected?.options).toEqual([
      { name: 'Color', values: ['Black'] },
      { name: 'Color', values: ['Clear'] },
    ]);
    expect(projected?.valuesByVariant.get('v1')).toHaveLength(2);
  });

  it('gives a variant with no assignment an EMPTY list rather than omitting it', () => {
    // The commonest variant in this catalogue: a single-SKU listing's one
    // variant has no axis value and still exists. Omitting it would make the
    // caller unable to tell "no values" from "not projected".
    const projected = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [assignment('v1', 'color', 'Ice')],
      ['v1', 'v2'],
    );
    expect(projected?.valuesByVariant.has('v2')).toBe(true);
    expect(projected?.valuesByVariant.get('v2')).toEqual([]);
  });

  it('emits every variant in the listing DECLARED axis order, whatever order the rows arrive in', () => {
    // Two variants of one listing must never disagree about which option comes
    // first. The assignments below are supplied in opposite orders on purpose.
    const axes = [axis('size', 'Size', 0), axis('color', 'Color', 1)];
    const projected = projectTypedListingAxes(
      axes,
      [
        assignment('v1', 'color', 'Ice'),
        assignment('v1', 'size', 'M'),
        assignment('v2', 'size', 'L'),
        assignment('v2', 'color', 'Dawn'),
      ],
      ['v1', 'v2'],
    );
    expect(projected?.valuesByVariant.get('v1')?.map((o) => o.name)).toEqual(['Size', 'Color']);
    expect(projected?.valuesByVariant.get('v2')?.map((o) => o.name)).toEqual(['Size', 'Color']);
  });

  it('collects each axis DISTINCT values across variants, in first-seen order', () => {
    const projected = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [
        assignment('v1', 'color', 'Ice'),
        assignment('v2', 'color', 'Dawn'),
        assignment('v3', 'color', 'Ice'),
      ],
      ['v1', 'v2', 'v3'],
    );
    expect(projected?.options).toEqual([{ name: 'Color', values: ['Ice', 'Dawn'] }]);
  });

  it('ignores an assignment naming an axis this listing does not declare', () => {
    // The caller batches across a PAGE of listings, so a sibling's rows are one
    // mis-scoped bucket away. Leaking one would put another listing's option on
    // this listing's page.
    const projected = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [assignment('v1', 'color', 'Ice'), assignment('v1', 'storage', '256 GB')],
      ['v1'],
    );
    expect(projected?.options).toEqual([{ name: 'Color', values: ['Ice'] }]);
    expect(projected?.valuesByVariant.get('v1')).toEqual([{ name: 'Color', value: 'Ice' }]);
  });
});

describe('classifyVariantAxisShadow', () => {
  const legacy = (pairs: Record<string, ProjectedVariantOptionValue[]>) =>
    new Map(Object.entries(pairs));

  it('is agreed when both representations are empty', () => {
    expect(classifyVariantAxisShadow(null, legacy({ v1: [] }))).toBe('agreed');
  });

  it('is typed_absent when legacy has options and no typed axis exists', () => {
    // The migration backlog, measured on live traffic. Expected today for the
    // whole catalogue.
    expect(
      classifyVariantAxisShadow(null, legacy({ v1: [{ name: 'Color', value: 'Ice' }] })),
    ).toBe('typed_absent');
  });

  it('is legacy_absent when typed axes exist and legacy carries nothing', () => {
    const typed = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(classifyVariantAxisShadow(typed, legacy({ v1: [] }))).toBe('legacy_absent');
  });

  it('is agreed when the two representations render the same pairs', () => {
    const typed = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(
      classifyVariantAxisShadow(typed, legacy({ v1: [{ name: 'Color', value: 'Ice' }] })),
    ).toBe('agreed');
  });

  it('is diverged when a variant edit moved the legacy value and left the typed axis stale', () => {
    // THE case the shadow exists for. `updateVariant` replaces
    // `product_variant_option_values` and touches no typed axis, so a connector
    // re-sync or a merchant edit produces exactly this state — and under `on` a
    // shopper would be served the stale typed value.
    const typed = projectTypedListingAxes(
      [axis('color', 'Color', 0)],
      [assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(
      classifyVariantAxisShadow(typed, legacy({ v1: [{ name: 'Color', value: 'Powder' }] })),
    ).toBe('diverged');
  });

  it('is AGREED when only the axis NAME differs, because that is the feature working', () => {
    // `Colour` resolving to the definition labelled `Color` is precisely what
    // ADR 0007 D6 exists to do. Counting it as divergence would mark every
    // backfilled listing permanently diverged and leave the counter unable to
    // report the stale VALUE it exists for — a metric that is always red.
    const typed = projectTypedListingAxes(
      [axis('color', 'Color', 0, 'Colour')],
      [assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(
      classifyVariantAxisShadow(typed, legacy({ v1: [{ name: 'Colour', value: 'Ice' }] })),
    ).toBe('agreed');
  });

  it('is diverged when the two agree on pairs but not on ORDER', () => {
    // Option order is part of what a shopper sees, so an ordering difference is
    // a difference. Without this the comparison would report agreement on a
    // listing whose two representations render differently.
    const typed = projectTypedListingAxes(
      [axis('size', 'Size', 0), axis('color', 'Color', 1)],
      [assignment('v1', 'size', 'M'), assignment('v1', 'color', 'Ice')],
      ['v1'],
    );
    expect(
      classifyVariantAxisShadow(
        typed,
        legacy({
          v1: [
            { name: 'Color', value: 'Ice' },
            { name: 'Size', value: 'M' },
          ],
        }),
      ),
    ).toBe('diverged');
  });

  it('is diverged when the typed side is missing a pair the legacy side has', () => {
    const typed = projectTypedListingAxes(
      [axis('size', 'Size', 0)],
      [assignment('v1', 'size', 'M')],
      ['v1'],
    );
    expect(
      classifyVariantAxisShadow(
        typed,
        legacy({
          v1: [
            { name: 'Size', value: 'M' },
            { name: 'Color', value: 'Ice' },
          ],
        }),
      ),
    ).toBe('diverged');
  });
});
