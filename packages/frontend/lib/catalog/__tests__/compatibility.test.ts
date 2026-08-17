/**
 * The storefront's fitment composition, executed (#367 workstream 5).
 *
 * ## The one property this file exists for
 *
 * `GET /compatibility/fitments` publishes the vehicles a part is stated NOT to fit
 * alongside the ones it fits, and offers no parameter to remove them — because a
 * read narrowed to `applies` answers a confident yes for every vehicle somebody
 * explicitly excluded. That moves the whole burden onto the client: **an exclusion
 * must render AS an exclusion.**
 *
 * Before this landed, `CompatibilityPanel` rendered a flat list of vehicle names
 * under one "Compatibility" heading, so a `does_not_apply` row printed identically
 * to a fit. Nothing caught it: the component had no test, the panel was unreachable
 * because the read was unwired, and `tsc`, ESLint, every isolation gate and the
 * storefront catalog gate were all green on it. It is the highest-cost wrong answer
 * in this epic and it lived in the renderer rather than in the data.
 *
 * So the cases below are about the PARTITION, and the first one fails on exactly
 * the shape that used to ship.
 *
 * ## What a gate cannot see here
 *
 * `validate-storefront-catalog-driven.mjs` caught a real defect in this module
 * while it was being written — `FITMENT_GROUP_ORDER` re-listed the four members of
 * `COMPATIBILITY_APPLICABILITIES` as an array, which is the hand-relisted-union
 * shape that has already shipped a live bug in this repository. That is SHAPE. It
 * cannot see that the order is right, that an empty group is dropped, or that a
 * failed read is distinguished from an absent one.
 */

import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_APPLICABILITIES } from '@mercaria/shared-types';
import type {
  AutomotiveFitmentView,
  CompatibilityApplicability,
} from '@mercaria/shared-types';
import {
  composeProductCompatibility,
  fitmentSubjects,
  partitionFitment,
} from '../compatibility';

/** One statement, with only the fields the composition reads spelled out. */
function fitment(
  id: string,
  applicability: CompatibilityApplicability,
  makeName = 'SEAT',
): AutomotiveFitmentView {
  return {
    id,
    subject: { kind: 'canonical_variant', variantId: 'v1' },
    scope: 'vehicle_make',
    make: { id: 'mk1', key: 'seat', name: makeName },
    model: null,
    generation: null,
    configuration: null,
    applicability,
    position: 'front',
    qualifiers: [],
    conditionKinds: [],
    conditionNote: null,
    yearFrom: null,
    yearTo: null,
    verification: 'verified',
    verificationMethod: 'manufacturer_publication',
  };
}

describe('an exclusion is never grouped with a fit', () => {
  it('separates `does_not_apply` from `applies` — the shape that used to ship', () => {
    const groups = partitionFitment([
      fitment('f1', 'applies', 'SEAT'),
      fitment('f2', 'does_not_apply', 'Cupra'),
      fitment('f3', 'applies', 'Volkswagen'),
    ]);

    // Two groups, never one flat list. A single group here is the bug: the panel
    // renders one heading per group, so a flat list puts "Cupra" under whatever
    // that heading says.
    expect(groups).toHaveLength(2);
    expect(groups[0]?.applicability).toBe('applies');
    expect(groups[0]?.fitments.map((entry) => entry.id)).toEqual(['f1', 'f3']);
    expect(groups[1]?.applicability).toBe('does_not_apply');
    expect(groups[1]?.fitments.map((entry) => entry.id)).toEqual(['f2']);
  });

  it('keeps `unknown` apart from `does_not_apply` — different sentences', () => {
    // "We have no data for your car" is not "this does not fit your car", and
    // collapsing them either way is a wrong answer with a consequence.
    const groups = partitionFitment([
      fitment('f1', 'unknown'),
      fitment('f2', 'does_not_apply'),
    ]);
    expect(groups.map((group) => group.applicability)).toEqual(['does_not_apply', 'unknown']);
  });

  it('keeps `partially_applies` apart from `applies` — a caveat is not a yes', () => {
    const groups = partitionFitment([
      fitment('f1', 'partially_applies'),
      fitment('f2', 'applies'),
    ]);
    expect(groups.map((group) => group.applicability)).toEqual(['applies', 'partially_applies']);
  });

  it('emits a group only when it holds something', () => {
    const groups = partitionFitment([fitment('f1', 'applies')]);
    // An empty "does not fit" heading reads as a warning about nothing.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.applicability).toBe('applies');
  });

  it('presents them strongest-first, whatever order they arrived in', () => {
    const groups = partitionFitment([
      fitment('f1', 'unknown'),
      fitment('f2', 'does_not_apply'),
      fitment('f3', 'partially_applies'),
      fitment('f4', 'applies'),
    ]);
    expect(groups.map((group) => group.applicability)).toEqual([
      'applies',
      'partially_applies',
      'does_not_apply',
      'unknown',
    ]);
  });

  it('places every member of the shared vocabulary, with none left over', () => {
    // The positive control for the partition itself: one statement per
    // applicability must produce one group per applicability. A `Record` missing a
    // member would drop rows here rather than mis-file them, which is the quieter
    // half of the same defect.
    const groups = partitionFitment(
      COMPATIBILITY_APPLICABILITIES.map((applicability, index) =>
        fitment(`f${String(index)}`, applicability),
      ),
    );
    expect(groups).toHaveLength(COMPATIBILITY_APPLICABILITIES.length);
    expect(groups.flatMap((group) => group.fitments)).toHaveLength(
      COMPATIBILITY_APPLICABILITIES.length,
    );
    expect(COMPATIBILITY_APPLICABILITIES.length).toBeGreaterThanOrEqual(4);
  });
});

describe('a failed read is not an absent fitment', () => {
  it('reports `read_failed` even when the read also produced nothing', () => {
    // The check order is the property: a broken endpoint must never be presented
    // as "this part fits nothing", which is a statement about the part.
    const composed = composeProductCompatibility({
      fitments: [],
      truncated: false,
      readFailed: true,
    });
    expect(composed).toEqual({ state: 'unavailable', reason: 'read_failed' });
  });

  it('reports `no_published_fitment` for the ordinary case', () => {
    const composed = composeProductCompatibility({
      fitments: [],
      truncated: false,
      readFailed: false,
    });
    // Most products have no fitment relationship at all — a phone is not missing
    // this data, it has none — so this is the common answer and it renders nothing.
    expect(composed).toEqual({ state: 'unavailable', reason: 'no_published_fitment' });
  });

  it('carries truncation through, so a page is never presented as the whole set', () => {
    const composed = composeProductCompatibility({
      fitments: [fitment('f1', 'applies')],
      truncated: true,
      readFailed: false,
    });
    expect(composed.state).toBe('available');
    if (composed.state !== 'available') return;
    expect(composed.truncated).toBe(true);
  });
});

describe('which subjects a product page reads', () => {
  const PRODUCT = 'prod_1';

  it('reads the product alone when it has several configurations and none is selected', () => {
    // A fitment attached to one configuration is not a statement about its
    // siblings, so with no configuration in view nothing configuration-specific
    // may be shown.
    expect(
      fitmentSubjects({
        canonicalProductId: PRODUCT,
        selectedVariantId: undefined,
        variantIds: ['v1', 'v2'],
      }),
    ).toEqual([{ kind: 'canonical_product', productId: PRODUCT }]);
  });

  it('reads the product AND the selected configuration', () => {
    expect(
      fitmentSubjects({
        canonicalProductId: PRODUCT,
        selectedVariantId: 'v2',
        variantIds: ['v1', 'v2'],
      }),
    ).toEqual([
      { kind: 'canonical_product', productId: PRODUCT },
      { kind: 'canonical_variant', variantId: 'v2' },
    ]);
  });

  it('reads the ONLY configuration without waiting to be told — the brake-pad shape', () => {
    // The reference vertical is "a product with ZERO variant axes, one canonical
    // variant" and attaches its eleven fitment statements to that variant. Without
    // this clause every one of them is invisible until a shopper selects the only
    // option there is, which is a selector the page does not even render.
    expect(
      fitmentSubjects({
        canonicalProductId: PRODUCT,
        selectedVariantId: undefined,
        variantIds: ['v_only'],
      }),
    ).toEqual([
      { kind: 'canonical_product', productId: PRODUCT },
      { kind: 'canonical_variant', variantId: 'v_only' },
    ]);
  });

  it('reads NOTHING without a product — the page has not loaded yet', () => {
    expect(
      fitmentSubjects({
        canonicalProductId: undefined,
        selectedVariantId: 'v1',
        variantIds: ['v1'],
      }),
    ).toEqual([]);
    // And an empty string is the same absence, because that is what a
    // `page?.product.id ?? ''` fallback produces.
    expect(
      fitmentSubjects({ canonicalProductId: '', selectedVariantId: undefined, variantIds: [] }),
    ).toEqual([]);
  });
});
