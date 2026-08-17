/**
 * May a draft publish while one of its values is still a proposal?
 * (#367 step 6, ADR 0007 D9's last paragraph.)
 *
 * D9: *"Where the product type's policy permits it, a product may publish
 * carrying a local claim while its proposal is pending. Where it does not,
 * publication waits. **Which of the two applies is a property of the product type
 * version, so it is versioned and reviewable rather than a per-request
 * decision.**"*
 *
 * So this module DECIDES NOTHING. It reads `pending_proposal_policy` off the
 * product type version the draft already pins — a column
 * `product_type_definitions_immutable_once_published` freezes — and turns it into
 * findings. There is no configuration here, no flag, and no parameter a caller
 * could pass to get the other answer: a per-request override is precisely what
 * D9's sentence forbids, and the way one arrives is a "just for this call"
 * boolean that reads as flexibility.
 *
 * ## Two codes, both DEFINED by step 5 and produced by nothing until now
 *
 * `services/catalog-authoring/validation.ts` closes with a note saying
 * `proposal_pending_blocks_publication` and `proposal_not_permitted` are in the
 * closed set and produced by nothing, because until `catalog_proposals` existed a
 * value that is "still a proposal" had no representation — and a check for one
 * would be a check that can never fire, which reads as coverage. This is the
 * producer that note names, and it adds no vocabulary.
 *
 * ## `allow_local_claim` produces NO finding, and not a warning
 *
 * A warning would be a sentence saying something is wrong about a publication the
 * versioned policy permits. The verdict a caller gets is
 * `permitted_as_local_claim`, which a surface may render however it likes; the
 * VALIDATION result stays clean, because `publishable` is what publish reads and
 * a permitted publication is publishable.
 */

import type {
  AuthoringValidationFinding,
  AuthoringValidationResult,
  CatalogProposalPublicationVerdict,
  ProductTypePendingProposalPolicy,
} from '@mercaria/shared-types';

/** What the gate is given. Deliberately the two facts and nothing else. */
export interface PendingProposalGateInput {
  /** The policy of the product type VERSION the draft pins. Never a request flag. */
  readonly pendingProposalPolicy: ProductTypePendingProposalPolicy;
  /** The OPEN proposals this draft is waiting on, from the reference table. */
  readonly openProposalIds: readonly string[];
}

/**
 * The verdict, as a STRING discriminant.
 *
 * The backend compiles with `strict: false`, so TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — `if (!x.blocked)`
 * would leave a caller holding the whole union. Measured in #68 and again in
 * #110; the string is not a style choice.
 */
export function decidePendingProposalPublication(
  input: PendingProposalGateInput,
): CatalogProposalPublicationVerdict {
  if (input.openProposalIds.length === 0) return { verdict: 'clear' };
  if (input.pendingProposalPolicy === 'allow_local_claim') {
    return { verdict: 'permitted_as_local_claim', proposalIds: [...input.openProposalIds] };
  }
  return { verdict: 'blocked', proposalIds: [...input.openProposalIds] };
}

/**
 * The findings a verdict contributes to a draft's validation.
 *
 * `blocked` produces ONE finding at the draft level rather than one per
 * proposal: the author's remedy is the same whichever of their pending values is
 * named — wait, or remove the value — and a list of eleven identical errors on a
 * form is a list nobody reads.
 */
export function pendingProposalFindings(
  verdict: CatalogProposalPublicationVerdict,
): readonly AuthoringValidationFinding[] {
  if (verdict.verdict !== 'blocked') return [];
  return [
    {
      code: 'proposal_pending_blocks_publication',
      severity: 'error',
      path: 'draft.pendingProposals',
    },
  ];
}

/**
 * A finding for a proposal attached to a field whose value policy does not admit
 * one.
 *
 * The other half of step 5's seam. A proposal is only ever accepted for a field
 * whose `value_policy` is `proposal_enabled` — the submission refuses anything
 * else outright — so this fires for a draft whose PRODUCT TYPE VERSION changed
 * underneath it: the field was proposal-enabled when the value was entered and is
 * not any more. That is exactly the case a submission-time check cannot cover,
 * and it is why the code exists at validation as well.
 */
export function proposalNotPermittedFinding(path: string, about: {
  readonly fieldId: string;
  readonly attributeKey: string;
}): AuthoringValidationFinding {
  return {
    code: 'proposal_not_permitted',
    severity: 'error',
    path,
    fieldId: about.fieldId,
    attributeKey: about.attributeKey,
  };
}

/**
 * Merge proposal findings into a validation result.
 *
 * The recomputation of `publishable` lives HERE, in one place, rather than at
 * each call site: "publishable means no error-severity finding" is one rule, and
 * a caller re-deriving it is the two-spellings-of-one-rule failure
 * `order-buyer-claim` names — with the difference that the wrong spelling here
 * publishes a product carrying a value nobody approved.
 */
export function withProposalFindings(
  result: AuthoringValidationResult,
  extra: readonly AuthoringValidationFinding[],
): AuthoringValidationResult {
  if (extra.length === 0) return result;
  const findings = [...result.findings, ...extra];
  return {
    publishable: !findings.some((entry) => entry.severity === 'error'),
    findings,
    schemaEtag: result.schemaEtag,
  };
}
