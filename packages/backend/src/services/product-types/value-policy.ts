/**
 * Does a product-type field's VALUE POLICY agree with the attribute it cites
 * (#367, ADR 0007 D5)?
 *
 * `product_type_fields.value_policy` says HOW a value is supplied;
 * `attribute_definitions.value_type` says WHAT the value is. They are different
 * questions with different owners, which is right — and it means they can
 * disagree, because nothing was checking.
 *
 * ## What could be stored before this existed
 *
 * A field with `value_policy = 'controlled_value'` citing a `decimal` attribute,
 * or `typed_scalar` citing an `enum`. Both stored cleanly, both published
 * cleanly, and both then behaved as the ATTRIBUTE's type says rather than as the
 * policy says: `services/catalog-authoring/validation.ts`'s `expectedKind`
 * derives the answer shape from `validation.valueType` for every policy except
 * `canonical_reference`. So the policy was decorative on three of its five
 * members — a schema saying "pick from a list" while the form accepted a
 * number, with no error anywhere.
 *
 * That is worth refusing at PUBLICATION rather than at authoring, for the reason
 * every other publication check here gives: a draft is half-finished by
 * definition, and refusing an incomplete one makes it impossible to save work.
 * From publication the version is frozen by trigger, so publication is the last
 * moment anybody can look.
 *
 * ## Why this is not a CHECK
 *
 * The rule spans two tables — the field's policy and the cited definition's
 * value type — and a CHECK admits no subquery. The citation columns that let
 * `product_type_fields_variant_axis_check` work carry the attribute's KEY and
 * VERSION, deliberately not its type: #94 is the one authority on what a value
 * means, and copying the type here to make a CHECK possible would create exactly
 * the second description of one fact this domain refuses everywhere else. So the
 * agreement is a service check over a read, and it is stated once, here.
 *
 * ## `canonical_reference` constrains NOTHING, deliberately
 *
 * It is the one policy that OVERRIDES the attribute's type rather than agreeing
 * with it — `expectedKind` returns `canonical_reference` for it before it ever
 * looks at `valueType`. A field pointing at a canonical brand may legitimately
 * cite a `string` attribute, and refusing that would break the one policy whose
 * whole job is to mean "this is a pointer, not a literal". Stated as an empty
 * allowed-set with this reason rather than omitted, so the absence reads as a
 * decision.
 */

import type { AttributeValueType, ProductTypeValuePolicy } from '@mercaria/shared-types';

/**
 * The value types each policy admits.
 *
 * A `Record` over the policy union with no index signature, so **adding a
 * `ProductTypeValuePolicy` member is a `tsc` error here** — which is the only
 * place a new policy MUST be classified, and the alternative (a lookup with a
 * default) would silently admit everything for it.
 *
 * `null` means "this policy constrains nothing" and is NOT the empty set: an
 * empty array would refuse every attribute, and the two would be one keystroke
 * apart. See `canonical_reference` in the header.
 */
export const VALUE_POLICY_ADMITS: Readonly<
  Record<ProductTypeValuePolicy, readonly AttributeValueType[] | null>
> = {
  // A controlled value IS one of the attribute's own enum values. Anything else
  // has no list to pick from.
  controlled_value: ['enum'],
  // A proposal proposes a MISSING controlled value, so the attribute has to be
  // the kind of thing that has controlled values at all (ADR 0007 D9).
  proposal_enabled: ['enum'],
  // Everything a single typed literal can be. `enum` is excluded because that is
  // `controlled_value`'s job, and `structured` because it is `typed_structured`'s
  // — a policy that admitted them would make three members interchangeable.
  typed_scalar: ['boolean', 'integer', 'decimal', 'string', 'date', 'money', 'measurement'],
  // The multi-axis shape: 155.6 x 71.5 x 8.25 mm as three facts.
  typed_structured: ['structured'],
  // Constrains nothing. See the header.
  canonical_reference: null,
};

/** One field's citation, as much of it as this rule reads. */
export interface ValuePolicyCitation {
  readonly attributeKey: string;
  readonly valuePolicy: ProductTypeValuePolicy;
  readonly valueType: AttributeValueType;
}

/**
 * The verdict. A STRING discriminant, and the refused branch carries the pair
 * that disagreed — the backend compiles with `strict: false`, so a
 * boolean-literal discriminant would not narrow (#68's finding).
 */
export type ValuePolicyAgreement =
  | { readonly outcome: 'agrees' }
  | {
      readonly outcome: 'contradicts';
      readonly attributeKey: string;
      readonly valuePolicy: ProductTypeValuePolicy;
      readonly valueType: AttributeValueType;
      /** What the policy would have accepted. Never empty on this branch. */
      readonly admits: readonly AttributeValueType[];
    };

/** Pure, so the whole table of shapes is exercised without a database. */
export function assessValuePolicy(citation: ValuePolicyCitation): ValuePolicyAgreement {
  const admits = VALUE_POLICY_ADMITS[citation.valuePolicy];
  if (admits === null) return { outcome: 'agrees' };
  if (admits.includes(citation.valueType)) return { outcome: 'agrees' };
  return {
    outcome: 'contradicts',
    attributeKey: citation.attributeKey,
    valuePolicy: citation.valuePolicy,
    valueType: citation.valueType,
    admits,
  };
}

/**
 * The operator-facing sentence.
 *
 * It names the FIELD, the policy, the type it contradicts AND what that policy
 * would have accepted, because `controlled_value` on a `decimal` and
 * `typed_scalar` on an `enum` are different mistakes with different fixes — the
 * first wants the attribute changing or the policy relaxing, the second wants
 * `controlled_value`. A message saying only "the policy contradicts the
 * attribute" sends somebody to read both rows to learn which.
 */
export function describeValuePolicyRefusal(
  verdict: Extract<ValuePolicyAgreement, { outcome: 'contradicts' }>,
): string {
  return (
    `Field "${verdict.attributeKey}" has value policy "${verdict.valuePolicy}", ` +
    `but the attribute definition it cites is "${verdict.valueType}". ` +
    `"${verdict.valuePolicy}" accepts ${verdict.admits.map((type) => `"${type}"`).join(', ')}.`
  );
}
