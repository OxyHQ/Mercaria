/**
 * May this field be proposed against at all? (#367 step 6, ADR 0007 D9.)
 *
 * `product_type_fields.value_policy` has one member — `proposal_enabled` — that
 * admits a value the registry does not already carry, and its own doc comment in
 * `@mercaria/shared-types` says why: it is what keeps "a merchant proposal never
 * becomes globally trusted data by being submitted" checkable in ONE place. This
 * module is that place.
 *
 * ## The version is DERIVED, never supplied
 *
 * A submission names an attribute DEFINITION id and this reads the version off
 * the row it points at. `attributeDefinitionVersion` is in
 * `CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS` for the reason a caller cannot be
 * trusted with it: a supplied version could cite one whose controlled-value set
 * is not the set the submitter was shown, which would make the duplicate scan a
 * measurement against a different population from the one that produced the
 * request.
 *
 * ## An unresolvable field REFUSES, and it does not default
 *
 * A proposal against a product type version this attribute is not a field of, or
 * against a field whose policy is anything but `proposal_enabled`, is refused.
 * Silence would be the permissive reading of a missing rule, and the permissive
 * reading here is a merchant able to attach free text to a `controlled_value`
 * field — precisely the answer the value policy exists to refuse.
 */

import type { ProductTypeAuthoringFlow } from '@mercaria/shared-types';
import { forbidden, notFound } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findAttributeDefinitionById } from '../../db/attributes/definitionRepository.js';
import { listProductTypeFields } from '../../db/productTypes/productTypeFieldRepository.js';

/** What the caller resolved about the field a proposal is attached to. */
export interface ProposalFieldEligibility {
  readonly attributeDefinitionId: string;
  readonly attributeDefinitionVersion: number;
  readonly fieldId: string;
  readonly attributeKey: string;
}

/**
 * Resolve the version pin and refuse a field the product type does not open to
 * proposals.
 *
 * The product type version and the flow come from the DRAFT the answer belongs
 * to when there is one, so the check runs against the exact version the answer
 * was given under — the pin ADR 0007 D5 requires, applied to the question of
 * whether the answer may exist at all.
 */
export async function requireProposalEnabledField(
  db: DatabaseOrTransaction,
  input: {
    readonly attributeDefinitionId: string;
    readonly productTypeDefinitionId: string;
    readonly flow: ProductTypeAuthoringFlow;
  },
): Promise<ProposalFieldEligibility> {
  const definition = await findAttributeDefinitionById(db, input.attributeDefinitionId);
  if (definition === undefined) throw notFound('No such attribute definition.');

  const fields = await listProductTypeFields(db, input.productTypeDefinitionId, input.flow);
  const field = fields.find((row) => row.attributeDefinitionId === input.attributeDefinitionId);
  if (field === undefined) {
    throw forbidden('That attribute is not a field of this product type in this flow.');
  }
  if (field.valuePolicy !== 'proposal_enabled') {
    // The refusal NAMES the policy. "Not permitted" alone would send a merchant
    // looking for a permission they lack, when the answer is that this field
    // takes the values the registry carries and nothing else.
    throw forbidden(
      `“${field.attributeKey}” takes ${field.valuePolicy} values; this product type version does ` +
        'not open it to proposals.',
    );
  }

  return {
    attributeDefinitionId: definition.id,
    attributeDefinitionVersion: definition.version,
    fieldId: field.id,
    attributeKey: field.attributeKey,
  };
}

/**
 * The version pin for a proposal that names an attribute but no field.
 *
 * Used by the redirect path and by an `attribute`-typed proposal, neither of
 * which is an answer to a field: the first is an operator continuing a request
 * and the second is asking for the field to EXIST. Both still pin the version
 * they were made against, because a decision made under one registry version and
 * read under another is a decision nobody can reproduce.
 */
export async function resolveAttributeVersionPin(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
): Promise<number> {
  const definition = await findAttributeDefinitionById(db, attributeDefinitionId);
  if (definition === undefined) throw notFound('No such attribute definition.');
  return definition.version;
}
