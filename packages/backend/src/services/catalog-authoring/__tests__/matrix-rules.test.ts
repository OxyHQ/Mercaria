/**
 * The matrix rules a schema SERVES are the bounds the server ENFORCES
 * (#367 line 405).
 *
 * Line 405 asks the `AuthoringSchema` to *"include variant-axis capabilities
 * and matrix rules"*. `AuthoringField.variantCapable` was already the
 * capabilities half; `AuthoringSchema.matrix` is the rules half, and this file
 * is the reason publishing them is worth anything.
 *
 * ## What was actually wrong, and what a weaker test would miss
 *
 * Before this, `MAX_VARIANT_AXES_PER_PRODUCT` (16) and
 * `MAX_VALUES_PER_VARIANT_AXIS` (64) were defined in backend middleware and
 * referenced by **zero** files in `shared-types`, `ui`, `dashboard`, `frontend`
 * and `pos`. A bound the server enforces and no client can read is a bound the
 * client has to guess, and a guess is a literal nothing keeps in step.
 *
 * The obvious test — `expect(schema.matrix.maxAxes).toBe(16)` — would pass over
 * a server that had stopped enforcing 16 entirely. So this file does not compare
 * the served number to a literal. It **drives the real request schemas at the
 * served number and at one more**, so what is asserted is the relationship:
 * whatever the schema publishes is what the parser accepts, and one past it is
 * refused.
 *
 * `schema-version-lifecycle-exposure.realdb.test.ts` covers the other half —
 * that a real composition actually EMITS these three numbers. Neither file is
 * sufficient alone: this one never calls the composer, and that one never
 * drives the parser.
 *
 * ## The third number is a different bound, deliberately
 *
 * `matrix.maxVariants` is the PUBLISHED product's ceiling
 * (`config.catalog.maxVariantsPerProduct`, env `MAX_VARIANTS_PER_PRODUCT`), not
 * the draft's own storage cap. A draft may hold more — `patchProductDraftSchema`
 * caps `variants` at 200 — and publication runs through
 * `createStoreProductWithin`, which refuses above the config value. A client
 * generating a matrix is deciding what it will eventually be able to sell, so
 * the publishing bound is the one it needs.
 *
 * That gap is pinned below rather than left in prose, because the two numbers
 * are 200 and 100 today and nothing else in the repository says so in one place.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_VALUES_PER_VARIANT_AXIS,
  MAX_VARIANT_AXES_PER_PRODUCT,
} from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import {
  patchProductDraftSchema,
  createProductDraftSchema,
} from '../../../middleware/catalog-authoring-schemas.js';
import { createStoreProductSchema, updateVariantSchema } from '../../../middleware/schemas.js';

/** What a composed schema publishes, built from the SAME symbols as the composer. */
const SERVED = {
  maxAxes: MAX_VARIANT_AXES_PER_PRODUCT,
  maxValuesPerAxis: MAX_VALUES_PER_VARIANT_AXIS,
  maxVariants: config.catalog.maxVariantsPerProduct,
} as const;

/** `n` answers on one field. `text` because it needs no fixture id to exist. */
function values(n: number): { readonly text: string }[] {
  return Array.from({ length: n }, (_, index) => ({ text: `v${String(index)}` }));
}

/** `n` axes, each with one answer, each under its own machine key. */
function axes(n: number, valuesPerAxis = 1) {
  return Array.from({ length: n }, (_, index) => ({
    attributeKey: `axis_${String(index)}`,
    values: values(valuesPerAxis),
  }));
}

/** A legacy store-product `options` array: `n` options, `perOption` values each. */
function options(n: number, perOption = 1) {
  return Array.from({ length: n }, (_, index) => ({
    name: `Option ${String(index)}`,
    values: Array.from({ length: perOption }, (_, value) => `v${String(value)}`),
  }));
}

function storeProduct(over: Record<string, unknown>) {
  return {
    title: 'A product',
    description: '',
    category: 'shoes',
    imageFileIds: [],
    options: [],
    variants: [
      {
        optionValues: [],
        price: { amount: 1, currency: 'EUR' },
        inventory: { available: 0 },
      },
    ],
    ...over,
  };
}

describe('the published axis count is the enforced axis count', () => {
  it('the AUTHORING draft accepts exactly `maxAxes` and refuses one more', () => {
    const patch = (n: number) =>
      patchProductDraftSchema.safeParse({
        version: 1,
        variants: [{ inventoryAvailable: 0, axes: axes(n) }],
      }).success;

    expect(patch(SERVED.maxAxes), `${String(SERVED.maxAxes)} axes were refused`).toBe(true);
    expect(patch(SERVED.maxAxes + 1), 'one axis past the published cap was accepted').toBe(false);
  });

  it('the LEGACY store-product write accepts exactly `maxAxes` and refuses one more', () => {
    // Same published number, second enforcement site. `middleware/schemas.ts`
    // had no bound at all here until #906 and now imports the same symbol; if
    // it is ever re-pointed at a literal, this is where it surfaces.
    expect(createStoreProductSchema.safeParse(storeProduct({ options: options(SERVED.maxAxes) })).success)
      .toBe(true);
    expect(
      createStoreProductSchema.safeParse(storeProduct({ options: options(SERVED.maxAxes + 1) }))
        .success,
      'one option past the published cap was accepted',
    ).toBe(false);
  });

  it('a variant may carry exactly `maxAxes` optionValues and no more', () => {
    const optionValues = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        name: `Option ${String(index)}`,
        value: 'v',
      }));

    expect(updateVariantSchema.safeParse({ optionValues: optionValues(SERVED.maxAxes) }).success)
      .toBe(true);
    expect(
      updateVariantSchema.safeParse({ optionValues: optionValues(SERVED.maxAxes + 1) }).success,
      'one optionValue past the published cap was accepted',
    ).toBe(false);
  });
});

describe('the published values-per-axis count is the enforced one', () => {
  it('the AUTHORING draft accepts exactly `maxValuesPerAxis` and refuses one more', () => {
    const patch = (n: number) =>
      patchProductDraftSchema.safeParse({
        version: 1,
        fields: [{ attributeKey: 'colour', values: values(n) }],
      }).success;

    expect(patch(SERVED.maxValuesPerAxis), `${String(SERVED.maxValuesPerAxis)} values were refused`)
      .toBe(true);
    expect(patch(SERVED.maxValuesPerAxis + 1), 'one value past the published cap was accepted')
      .toBe(false);
  });

  it('the LEGACY store-product write applies it per option', () => {
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(1, SERVED.maxValuesPerAxis) }),
      ).success,
    ).toBe(true);
    expect(
      createStoreProductSchema.safeParse(
        storeProduct({ options: options(1, SERVED.maxValuesPerAxis + 1) }),
      ).success,
      'one value past the published cap was accepted',
    ).toBe(false);
  });
});

describe('`maxVariants` is the PUBLISHING bound, and the draft cap is a different number', () => {
  it('publishes the configured product ceiling', () => {
    // The composer reads this same value. What makes it the right one to serve
    // is the enforcement site: `createStoreProductWithin` refuses above it, and
    // `publish.service.ts` reaches publication through exactly that function.
    expect(SERVED.maxVariants).toBe(config.catalog.maxVariantsPerProduct);
    // A ceiling of zero or a negative would publish a rule no product can meet;
    // it is env-driven (`MAX_VARIANTS_PER_PRODUCT`), so the floor is worth an
    // assertion rather than an assumption.
    expect(SERVED.maxVariants).toBeGreaterThan(0);
  });

  it('the DRAFT accepts more variants than the published ceiling — 200 against the config', () => {
    // Recorded rather than argued. A merchant may fill a draft with more
    // variants than publication will accept, and finds out at publish. Neither
    // number is changed here: which one should move is a decision, not a fix.
    const draftOf = (n: number) =>
      patchProductDraftSchema.safeParse({
        version: 1,
        variants: Array.from({ length: n }, () => ({ inventoryAvailable: 0, axes: [] })),
      }).success;

    expect(draftOf(200), 'the draft no longer accepts 200 variants').toBe(true);
    expect(draftOf(201), 'the draft cap is no longer 200').toBe(false);
    expect(
      200,
      'the draft cap and the publishing ceiling are equal now — this case is stale, and ' +
        'whichever change made them agree should delete it',
    ).toBeGreaterThan(SERVED.maxVariants);
  });
});

describe('the fixtures drive what they claim to (self-test)', () => {
  it('builds axis and option arrays of the length asked for', () => {
    // Without this, an `axes(n)` that silently produced one element would make
    // every "accepts N" case above pass for the wrong reason, and every
    // "refuses N+1" case fail loudly enough to be "fixed" by widening the cap.
    expect(axes(5)).toHaveLength(5);
    expect(axes(1, 7)[0].values).toHaveLength(7);
    expect(options(5)).toHaveLength(5);
    expect(options(1, 7)[0].values).toHaveLength(7);
  });

  it('the minimal bodies are otherwise VALID, so a refusal means the cap fired', () => {
    // The failure this rules out: a fixture that never parses at all, which
    // makes every `.success === false` assertion pass without the bound being
    // reached. Each body is parsed at ONE unit, where no cap can apply.
    expect(
      patchProductDraftSchema.safeParse({
        version: 1,
        fields: [{ attributeKey: 'colour', values: values(1) }],
        variants: [{ inventoryAvailable: 0, axes: axes(1) }],
      }).success,
      'the minimal draft patch does not parse — every refusal above is vacuous',
    ).toBe(true);
    expect(
      createStoreProductSchema.safeParse(storeProduct({ options: options(1) })).success,
      'the minimal store product does not parse — every refusal above is vacuous',
    ).toBe(true);
    expect(
      updateVariantSchema.safeParse({ optionValues: [{ name: 'Option 0', value: 'v' }] }).success,
      'the minimal variant patch does not parse — every refusal above is vacuous',
    ).toBe(true);
  });

  it('the create-draft schema is imported and real, so the module resolved', () => {
    // A path that resolved wrong throws on import rather than here; this is the
    // cheap floor that says the module under test is the one that exists.
    expect(typeof createProductDraftSchema.safeParse).toBe('function');
  });
});
