/**
 * The variant-axis prohibition (#367, ADR 0007 D6/D8), as a pure function the
 * write path calls BEFORE the database refuses the row.
 *
 * The authority is `product_type_fields_variant_axis_check`, which holds against
 * every writer including `psql`. This module exists so a person filling in a
 * schema gets a sentence naming the attribute and the reason, rather than a
 * constraint name — and it is deliberately a SECOND statement of the same rule
 * rather than the only one. `product-type-variant-axis.test.ts` renders the
 * CHECK's own expression from the same tuple this function reads, so the two
 * cannot drift into disagreeing about which keys are refused.
 *
 * ## The two walls, and why neither is redundant
 *
 * 1. **An axis is a `variant`-scope field.** A compatibility target — a vehicle
 *    generation, a socket, a year range — has scope `compatibility` and can
 *    therefore never be one. This is ADR 0007 D8's acceptance scenario held by
 *    the row's own shape: one brake-pad SKU fits four hundred vehicles and stays
 *    ONE variant, because "fits a 2014 Golf" has nowhere to be an option value.
 * 2. **And its attribute key is outside the forbidden set.** A compatibility
 *    fact mislabelled `scope: 'variant'` — which is the mistake somebody
 *    actually makes — is still refused, as is any key naming a price, a stock
 *    level or a seller's condition. Those are OFFER facts (ADR 0007 D5:
 *    composed, never modelled), and #94 already refuses to define them at all;
 *    this wall is what makes the prohibition local and checkable rather than a
 *    property borrowed from another table's constraint.
 */

import {
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  type ProductTypeFieldScope,
} from '@mercaria/shared-types';

/** Why a field may not define variants. A closed set, so a caller can act on it. */
export type VariantAxisRefusal = 'scope_is_not_variant' | 'attribute_may_not_be_an_axis';

/**
 * The verdict. A STRING discriminant and no `refusal` property on the permitted
 * branch, for the `strict: false` narrowing reason every union in this repository
 * states (#68).
 */
export type VariantAxisVerdict =
  | { readonly outcome: 'permitted' }
  | { readonly outcome: 'refused'; readonly refusal: VariantAxisRefusal; readonly attributeKey: string };

/**
 * May this (scope, attribute) pair carry `variant_capable`?
 *
 * Answers `permitted` for a field that is not variant-capable at all — the
 * question is only asked of one that claims to be, and a non-axis field has
 * nothing to refuse.
 */
export function assessVariantAxis(input: {
  scope: ProductTypeFieldScope;
  attributeKey: string;
  variantCapable: boolean;
}): VariantAxisVerdict {
  if (!input.variantCapable) return { outcome: 'permitted' };
  if (input.scope !== 'variant') {
    return {
      outcome: 'refused',
      refusal: 'scope_is_not_variant',
      attributeKey: input.attributeKey,
    };
  }
  if (PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.includes(input.attributeKey)) {
    return {
      outcome: 'refused',
      refusal: 'attribute_may_not_be_an_axis',
      attributeKey: input.attributeKey,
    };
  }
  return { outcome: 'permitted' };
}

/** The sentence a schema author reads. Named facts only — no constraint names. */
export function describeVariantAxisRefusal(verdict: VariantAxisVerdict): string | null {
  if (verdict.outcome === 'permitted') return null;
  if (verdict.refusal === 'scope_is_not_variant') {
    return `"${verdict.attributeKey}" may not define variants: only a field whose scope is "variant" can be an axis, and a compatibility target never is — one part fits many vehicles and stays one variant.`;
  }
  return `"${verdict.attributeKey}" may not define variants: it names a price, an availability, a seller condition or a compatibility target, and none of those is a property of a variant.`;
}
