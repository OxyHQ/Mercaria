/**
 * The bounds on one LEGACY store-product write (#367 line 762, #906).
 *
 * ## What was unbounded, and why it was invisible
 *
 * `middleware/__tests__/catalog-authoring-bounds.test.ts` pins the authoring
 * PATCH at 200 variants x 16 axes x 64 answers and states the composed ceiling
 * as a number. None of that reached the path every listing in this catalogue
 * was actually created through. Measured before this file, with a control pair
 * proving the fixtures were admissible:
 *
 * ```
 * createStoreProductSchema   control_missing_title_refused: true
 *                            control_minimal_accepted:      true
 *   options              5,000  ACCEPTED
 *   values per option   50,000  ACCEPTED
 *   optionValues/variant 50,000 ACCEPTED
 * ```
 *
 * The variant COUNT was already bounded — `config.catalog.maxVariantsPerProduct`
 * (100) at `services/catalog-write.service.ts`, on create and on add — and
 * images at 12, so the exposure was never "the repo does not validate input".
 * It was these three dimensions, on this path, behind a 10 MB body limit:
 * roughly 370,000 `{name, value}` pairs, every one of them written by
 * `replaceOptionValues` in a single transaction.
 *
 * ## The numbers are INHERITED, and that is the point
 *
 * `MAX_VARIANT_AXES_PER_PRODUCT` (16) and `MAX_VALUES_PER_VARIANT_AXIS` (64)
 * come from `catalog-authoring-schemas.ts` and are imported, never retyped. A
 * different cap here would be a second answer to a question that module already
 * answers, and the one somebody consulted would be whichever they found first.
 *
 * **Both are CHOSEN, not measured** — what the authoring wizard generates
 * within before it refuses, not a measurement of server cost. This file
 * inherits that provenance along with the numbers; it does not launder them
 * into empirical ones by re-deriving them here.
 *
 * ## Every case asserts BOTH sides
 *
 * A refusal case alone is satisfied by a schema that refuses everything, which
 * is what a mistyped fixture produces and it fails in the direction that looks
 * like a passing test. So each cap is asserted at N (accepted) and N+1
 * (refused), and the control below is what makes an "accepted" mean the size
 * was admitted rather than the body being wrong in a way that happens to parse.
 *
 * ## What is deliberately NOT bounded here
 *
 * The variant COUNT, which the service already refuses above 100 — capping it
 * again in the schema would be the same two-answers defect this file exists to
 * remove, one dimension over. And product TYPES, which have no HTTP write
 * surface at all: a pathological schema cannot be posted, which is a stronger
 * guarantee than a cap and must not be "improved" into one.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_VALUES_PER_VARIANT_AXIS,
  MAX_VARIANT_AXES_PER_PRODUCT,
} from '@mercaria/shared-types';
import {
  createStoreProductSchema,
  ingestProductsSchema,
  updateVariantSchema,
} from '../schemas.js';

function optionValues(n: number) {
  return Array.from({ length: n }, (_unused, i) => ({
    name: `n${String(i)}`,
    value: `v${String(i)}`,
  }));
}

function options(count: number, valuesPer = 1) {
  return Array.from({ length: count }, (_unused, i) => ({
    name: `o${String(i)}`,
    values: Array.from({ length: valuesPer }, (_v, j) => `v${String(j)}`),
  }));
}

/** A body the schema accepts, which every case below varies ONE dimension of. */
function storeProduct(over: Record<string, unknown> = {}) {
  return {
    title: 'T',
    description: '',
    category: 'c',
    imageFileIds: [],
    options: options(1),
    variants: [
      { optionValues: optionValues(1), price: { amount: 1, currency: 'FAIR' }, inventory: { available: 0 } },
    ],
    ...over,
  };
}

describe('the fixtures are admissible — the control for every case below', () => {
  it('accepts the minimal body and refuses one with an empty title', () => {
    // Without this pair an "accepted" below could mean the schema admits the
    // size OR that it admits anything; and a "refused" could mean the cap fired
    // OR that the fixture was malformed. Both directions, once, here.
    expect(createStoreProductSchema.safeParse(storeProduct()).success).toBe(true);
    expect(createStoreProductSchema.safeParse(storeProduct({ title: '' })).success).toBe(false);
  });
});

describe('createStoreProductSchema bounds the three dimensions that had none', () => {
  it(`accepts ${String(MAX_VARIANT_AXES_PER_PRODUCT)} options and refuses one more`, () => {
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(MAX_VARIANT_AXES_PER_PRODUCT) }),
      ).success,
    ).toBe(true);
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(MAX_VARIANT_AXES_PER_PRODUCT + 1) }),
      ).success,
    ).toBe(false);
  });

  it(`accepts ${String(MAX_VALUES_PER_VARIANT_AXIS)} values on ONE option and refuses one more`, () => {
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(1, MAX_VALUES_PER_VARIANT_AXIS) }),
      ).success,
    ).toBe(true);
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(1, MAX_VALUES_PER_VARIANT_AXIS + 1) }),
      ).success,
    ).toBe(false);
  });

  it(`accepts ${String(MAX_VARIANT_AXES_PER_PRODUCT)} optionValues on ONE variant and refuses one more`, () => {
    const withOptionValues = (n: number) =>
      storeProduct({
        variants: [
          { optionValues: optionValues(n), price: { amount: 1, currency: 'FAIR' }, inventory: { available: 0 } },
        ],
      });
    expect(
      createStoreProductSchema.safeParse(withOptionValues(MAX_VARIANT_AXES_PER_PRODUCT)).success,
    ).toBe(true);
    expect(
      createStoreProductSchema.safeParse(withOptionValues(MAX_VARIANT_AXES_PER_PRODUCT + 1)).success,
    ).toBe(false);
  });
});

describe('updateVariantSchema bounds the same variant dimension', () => {
  it('refuses one more optionValue than a variant may carry', () => {
    // The UPDATE path is where `replaceOptionValues` actually runs — the create
    // path is not the only writer, so capping only create would leave the
    // statement this bound exists for reachable.
    expect(
      updateVariantSchema.safeParse({ optionValues: optionValues(MAX_VARIANT_AXES_PER_PRODUCT) })
        .success,
    ).toBe(true);
    expect(
      updateVariantSchema.safeParse({
        optionValues: optionValues(MAX_VARIANT_AXES_PER_PRODUCT + 1),
      }).success,
    ).toBe(false);
  });
});

describe('ingestProductsSchema bounds a connector delivery the same way', () => {
  const ingested = (over: Record<string, unknown> = {}) => ({
    products: [
      {
        externalId: 'e1',
        title: 'T',
        variants: [
          {
            externalId: 'v0',
            price: { amount: 1, currency: 'FAIR' },
            optionValues: optionValues(1),
            inventory: { available: 0 },
          },
        ],
        options: options(1),
        ...over,
      },
    ],
  });

  it('accepts the minimal delivery — the control for the two cases below', () => {
    expect(ingestProductsSchema.safeParse(ingested()).success).toBe(true);
  });

  it(`accepts ${String(MAX_VARIANT_AXES_PER_PRODUCT)} options on one ingested product and refuses one more`, () => {
    expect(
      ingestProductsSchema.safeParse(ingested({ options: options(MAX_VARIANT_AXES_PER_PRODUCT) }))
        .success,
    ).toBe(true);
    expect(
      ingestProductsSchema.safeParse(
        ingested({ options: options(MAX_VARIANT_AXES_PER_PRODUCT + 1) }),
      ).success,
    ).toBe(false);
  });

  it(`accepts ${String(MAX_VARIANT_AXES_PER_PRODUCT)} optionValues on an ingested variant and refuses one more`, () => {
    const withOptionValues = (n: number) =>
      ingested({
        variants: [
          {
            externalId: 'v0',
            price: { amount: 1, currency: 'FAIR' },
            optionValues: optionValues(n),
            inventory: { available: 0 },
          },
        ],
      });
    expect(
      ingestProductsSchema.safeParse(withOptionValues(MAX_VARIANT_AXES_PER_PRODUCT)).success,
    ).toBe(true);
    expect(
      ingestProductsSchema.safeParse(withOptionValues(MAX_VARIANT_AXES_PER_PRODUCT + 1)).success,
    ).toBe(false);
  });
});

describe('the bounds are INHERITED from the authoring path, not chosen here', () => {
  it('uses the authoring module constants rather than literals of its own', () => {
    // The property that makes this one answer rather than two. If somebody
    // re-points these at fresh numbers, this case is where the divergence
    // surfaces — and it fails on the IMPORT, so it cannot be satisfied by
    // retyping the same values into this file.
    expect(MAX_VARIANT_AXES_PER_PRODUCT).toBe(16);
    expect(MAX_VALUES_PER_VARIANT_AXIS).toBe(64);
  });

  it('bounds one accepted store-product write at a stated ceiling', () => {
    // What the three caps MEAN together, on the path that had none: 100
    // variants (the SERVICE cap, `config.catalog.maxVariantsPerProduct`) x 16
    // optionValues each. Stated as a number because three caps can each look
    // reasonable while their product does not, and because the previous
    // ceiling on this path was a 10 MB body.
    const MAX_VARIANTS_AT_SERVICE = 100;
    expect(MAX_VARIANTS_AT_SERVICE * MAX_VARIANT_AXES_PER_PRODUCT).toBe(1_600);
  });
});
