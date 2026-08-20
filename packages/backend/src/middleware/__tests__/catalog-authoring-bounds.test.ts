/**
 * The bounds on one authoring request (#367 step 5, ADR 0007 D10).
 *
 * ## Why these specifically, and why nothing was watching them
 *
 * `patchProductDraftSchema` is the ONE body a merchant's whole product travels
 * in: every variant, every axis on every variant, every answer on every axis.
 * Its caps are what stop one PATCH from being an unbounded amount of work — and
 * measured before this file, NOT ONE of them was asserted anywhere. The only
 * test importing this module (`authored-text-sanitization.test.ts`) exercises
 * `title` and `description`; it parses bodies carrying no `variants` key at all.
 *
 * That matters more than a missing test usually does, because a cap is invisible
 * when it is right. Deleting `.max(200)` changes no behaviour any suite
 * observes, no type, no response shape and no log line: it changes only what a
 * hostile or broken client can make this server do, and only under a load
 * nobody runs in CI.
 *
 * ## The bound is the PRODUCT, which is why partial coverage is not coverage
 *
 * The four caps compose multiplicatively — a single accepted PATCH may carry
 * `variants` x `axes` x `values` answers, plus `fields` x `values` at the
 * product scope. Gating two of the four would leave the request unbounded
 * through the other two while reading as a request that is bounded, so all four
 * are pinned here and the composed ceiling is asserted as a number.
 *
 * ## Every case asserts the boundary from BOTH sides
 *
 * A refusal case alone is satisfied by a schema that refuses everything — which
 * is exactly what a mistyped fixture produces, and it fails in the direction
 * that looks like a passing test. So each cap is asserted at N (accepted) and
 * N+1 (refused), and the accepted side is checked with `success === true` rather
 * than "did not throw", because `safeParse` never throws.
 *
 * The client half of the same bound is `MAX_MATRIX_ROWS` in
 * `packages/dashboard/lib/authoring/matrix.ts`, pinned separately in that
 * package's own runner. Two pins rather than one shared constant is deliberate:
 * a dashboard test cannot import the backend (it would compile this package's
 * source under the dashboard's `strict: true`), and either side moving alone is
 * a real defect — a client that generates more rows than the server accepts
 * fails the save it just told the merchant to make, and a server cap lowered
 * under a client that still generates 200 does the same. Each pin is red for its
 * own side.
 */

import { describe, expect, it } from 'vitest';

import { patchProductDraftSchema } from '../catalog-authoring-schemas.js';

/** The smallest PATCH the route accepts: the compare-and-swap token, nothing else. */
const VERSION = { version: 1 } as const;

/** One answer the `answer` refinement admits — exactly one value member. */
function answer(ordinal: number) {
  return { ordinal, text: `value-${String(ordinal)}` };
}

/** One field's answers. `attributeKey` must match the stable-key shape. */
function fieldAnswers(index: number, values = 1) {
  return {
    attributeKey: `attr_${String(index)}`,
    values: Array.from({ length: values }, (_unused, ordinal) => answer(ordinal)),
  };
}

/** One variant. `inventoryAvailable` and `axes` are both required. */
function variant(axes = 0) {
  return {
    inventoryAvailable: 0,
    axes: Array.from({ length: axes }, (_unused, index) => fieldAnswers(index)),
  };
}

describe('patchProductDraftSchema bounds one product PATCH', () => {
  /**
   * The cap the dashboard's `MAX_MATRIX_ROWS` is the client half of. 200 is the
   * full Cartesian product the wizard will generate before it refuses.
   */
  it('accepts 200 variants and refuses 201', () => {
    const at = patchProductDraftSchema.safeParse({
      ...VERSION,
      variants: Array.from({ length: 200 }, () => variant()),
    });
    const over = patchProductDraftSchema.safeParse({
      ...VERSION,
      variants: Array.from({ length: 201 }, () => variant()),
    });

    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });

  /** 16 axes on ONE variant — the per-variant half of the product. */
  it('accepts 16 axes on a variant and refuses 17', () => {
    const at = patchProductDraftSchema.safeParse({
      ...VERSION,
      variants: [variant(16)],
    });
    const over = patchProductDraftSchema.safeParse({
      ...VERSION,
      variants: [variant(17)],
    });

    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });

  /** Product-scope answers. A patch names every field, including empty ones. */
  it('accepts 256 product fields and refuses 257', () => {
    const at = patchProductDraftSchema.safeParse({
      ...VERSION,
      fields: Array.from({ length: 256 }, (_unused, index) => fieldAnswers(index)),
    });
    const over = patchProductDraftSchema.safeParse({
      ...VERSION,
      fields: Array.from({ length: 257 }, (_unused, index) => fieldAnswers(index)),
    });

    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });

  /** The innermost multiplier: answers on ONE field. */
  it('accepts 64 answers on a field and refuses 65', () => {
    const at = patchProductDraftSchema.safeParse({
      ...VERSION,
      fields: [fieldAnswers(0, 64)],
    });
    const over = patchProductDraftSchema.safeParse({
      ...VERSION,
      fields: [fieldAnswers(0, 65)],
    });

    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });

  /**
   * The composed ceiling, stated as a number.
   *
   * Each cap above is pinned on its own, and this is what they MEAN together:
   * the largest number of variant-scope answers one accepted PATCH may carry.
   * It is asserted rather than commented because the individual caps can each
   * look reasonable while their product does not, and nothing else in the tree
   * multiplies them.
   */
  it('bounds one request at 204,800 variant-scope answers', () => {
    const MAX_VARIANTS = 200;
    const MAX_AXES_PER_VARIANT = 16;
    const MAX_ANSWERS_PER_AXIS = 64;

    expect(MAX_VARIANTS * MAX_AXES_PER_VARIANT * MAX_ANSWERS_PER_AXIS).toBe(204_800);

    // And the caps this arithmetic is over are the schema's own, not three
    // numbers retyped here — each is refused one above its bound.
    expect(
      patchProductDraftSchema.safeParse({
        ...VERSION,
        variants: Array.from({ length: MAX_VARIANTS + 1 }, () => variant()),
      }).success,
    ).toBe(false);
    expect(
      patchProductDraftSchema.safeParse({
        ...VERSION,
        variants: [variant(MAX_AXES_PER_VARIANT + 1)],
      }).success,
    ).toBe(false);
    expect(
      patchProductDraftSchema.safeParse({
        ...VERSION,
        variants: [
          {
            inventoryAvailable: 0,
            axes: [fieldAnswers(0, MAX_ANSWERS_PER_AXIS + 1)],
          },
        ],
      }).success,
    ).toBe(false);
  });

  /**
   * The vacuity floor for every case above.
   *
   * If the fixtures were malformed — a missing `inventoryAvailable`, an
   * `attributeKey` that fails its shape rule, an answer carrying two value
   * members — every "refuses N+1" assertion would pass for the wrong reason and
   * every "accepts N" assertion would be the only thing standing between this
   * file and a test that measures nothing. This asserts the fixture builders
   * produce a body the schema actually accepts, so a later edit that breaks one
   * fails HERE, naming the fixture, rather than silently hollowing out the file.
   */
  it('builds fixtures the schema genuinely accepts', () => {
    const result = patchProductDraftSchema.safeParse({
      ...VERSION,
      fields: [fieldAnswers(0, 2)],
      variants: [variant(2)],
    });

    expect(result.success).toBe(true);
  });
});
