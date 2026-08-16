/**
 * The product-type lifecycle and the composed read (#367, ADR 0007 D5).
 *
 * Publication is the only interesting operation here, and everything it does is
 * about making the version that is about to become permanent worth having:
 *
 *  - it REFUSES a version nothing could ever use — no category scope, or no
 *    field. Both publish cleanly and then silently never apply, which is the
 *    worst failure a schema can have because every surface keeps working;
 *  - it REFUSES a visibility rule that reads a field the same version and flow
 *    does not declare. A dangling reference evaluates to `unknown` forever, so
 *    the field it guards is hidden forever, and nothing anywhere reports it;
 *  - it re-states the variant-axis prohibition (ADR 0007 D6/D8) so the operator
 *    reads a sentence rather than a constraint name — the CHECK is still the
 *    authority and still holds against `psql`;
 *  - and it DEPRECATES the previous published version before flipping the new
 *    one, in one transaction, because
 *    `product_type_definitions_one_published_per_key` refuses any ordering that
 *    would leave two current schemas for one product type.
 *
 * From publication onward the version is frozen by trigger. That is the whole
 * reason these checks run HERE rather than at authoring time: a draft is
 * half-finished by definition and refusing an incomplete one would make it
 * impossible to save work.
 */

import type {
  ProductTypeAuthoringFlow,
  ProductTypeCategoryScopeSummary,
  ProductTypeDefinitionSummary,
  ProductTypeFieldGroupSummary,
  ProductTypeFieldSummary,
  ProductTypeVersionView,
} from '@mercaria/shared-types';
import { PRODUCT_TYPE_AUTHORING_FLOWS, PRODUCT_TYPE_EDITABLE_LIFECYCLES } from '@mercaria/shared-types';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProductTypeDefinitionById,
  findPublishedProductTypeDefinition,
  setProductTypeLifecycleIfIn,
  type ProductTypeDefinitionRow,
} from '../../db/productTypes/productTypeRepository.js';
import {
  listProductTypeCategoryScopes,
  listProductTypeFieldGroups,
  listProductTypeFields,
  type ProductTypeCategoryScopeRow,
  type ProductTypeFieldGroupRow,
  type ProductTypeFieldRow,
} from '../../db/productTypes/productTypeFieldRepository.js';
import { assessVariantAxis, describeVariantAxisRefusal } from './variant-axis.js';

/** Why a publication was refused. A closed set; a client never matches on text. */
export type ProductTypePublicationRefusal =
  | 'definition_not_found'
  | 'not_publishable_from_this_lifecycle'
  | 'no_category_scope'
  | 'no_fields'
  | 'visibility_rule_names_unknown_field'
  | 'variant_axis_refused';

/**
 * The outcome. A STRING discriminant, and the refused branch carries no
 * `definition` — a caller cannot reach a published version it did not get.
 */
export type ProductTypePublication =
  | { readonly outcome: 'published'; readonly definition: ProductTypeDefinitionRow }
  | {
      readonly outcome: 'refused';
      readonly refusal: ProductTypePublicationRefusal;
      readonly detail: string;
    };

function refused(
  refusal: ProductTypePublicationRefusal,
  detail: string,
): ProductTypePublication {
  return { outcome: 'refused', refusal, detail };
}

/**
 * Every attribute key a rule reads must be declared by the SAME version in the
 * SAME flow.
 *
 * The flow matters and dropping it would be the quiet mistake: a merchant-only
 * field guarding a P2P field means the P2P author is never asked the question
 * whose answer decides whether they see the second one, so the rule is
 * permanently `unknown` and the field permanently hidden — with every surface
 * reporting success.
 */
function findDanglingRuleField(fields: readonly ProductTypeFieldRow[]): {
  field: ProductTypeFieldRow;
  missing: string;
} | null {
  const declared = new Set(fields.map((field) => field.attributeKey));
  for (const field of fields) {
    const rule = field.visibilityRule;
    if (rule === null || rule === undefined) continue;
    for (const key of collectRuleFields(rule)) {
      if (!declared.has(key)) return { field, missing: key };
    }
  }
  return null;
}

/**
 * Every attribute key one rule reads.
 *
 * Walks the already-parsed AST, which `parseVisibilityRule` has bounded — so the
 * recursion here is over a structure whose depth and node count are known finite
 * before it is stored. Nothing untrusted reaches this function.
 */
function collectRuleFields(
  rule: NonNullable<ProductTypeFieldRow['visibilityRule']>,
  into: string[] = [],
): string[] {
  switch (rule.node) {
    case 'all':
    case 'any':
      for (const branch of rule.rules) collectRuleFields(branch, into);
      return into;
    case 'not':
      return collectRuleFields(rule.rule, into);
    default:
      if (!into.includes(rule.field)) into.push(rule.field);
      return into;
  }
}

/**
 * Publish a draft or in-review version, deprecating the key's current published
 * one in the same transaction.
 *
 * `now` is a parameter rather than a call to the clock, so a test pins the
 * publication instant instead of asserting a range.
 */
export async function publishProductTypeVersion(
  db: Database,
  input: { definitionId: string; publishedByOxyUserId: string; now?: Date },
): Promise<ProductTypePublication> {
  const at = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const definition = await findProductTypeDefinitionById(tx, input.definitionId);
    if (definition === null) {
      return refused('definition_not_found', `No product type version ${input.definitionId}.`);
    }
    if (!PRODUCT_TYPE_EDITABLE_LIFECYCLES.includes(definition.lifecycle)) {
      return refused(
        'not_publishable_from_this_lifecycle',
        `${definition.key} v${definition.version} is ${definition.lifecycle}; only a draft or in-review version can be published.`,
      );
    }

    const scopes = await listProductTypeCategoryScopes(tx, definition.id);
    if (scopes.length === 0) {
      return refused(
        'no_category_scope',
        `${definition.key} v${definition.version} is scoped to no category, so nothing could ever be authored under it.`,
      );
    }

    let anyField = false;
    for (const flow of PRODUCT_TYPE_AUTHORING_FLOWS) {
      const fields = await listProductTypeFields(tx, definition.id, flow);
      if (fields.length === 0) continue;
      anyField = true;

      for (const field of fields) {
        const verdict = assessVariantAxis({
          scope: field.scope,
          attributeKey: field.attributeKey,
          variantCapable: field.variantCapable,
        });
        if (verdict.outcome === 'refused') {
          return refused(
            'variant_axis_refused',
            describeVariantAxisRefusal(verdict) ?? 'This field may not define variants.',
          );
        }
      }

      const dangling = findDanglingRuleField(fields);
      if (dangling !== null) {
        return refused(
          'visibility_rule_names_unknown_field',
          `In flow "${flow}", the visibility rule on "${dangling.field.attributeKey}" reads "${dangling.missing}", which this version does not declare for that flow — the field it guards would be hidden forever.`,
        );
      }
    }

    if (!anyField) {
      return refused(
        'no_fields',
        `${definition.key} v${definition.version} declares no field in any flow.`,
      );
    }

    // Deprecate the incumbent FIRST. The partial unique index refuses the other
    // order, so this sequence is the constraint's, not a preference.
    const incumbent = await findPublishedProductTypeDefinition(tx, definition.key);
    if (incumbent !== null && incumbent.id !== definition.id) {
      await setProductTypeLifecycleIfIn(tx, incumbent.id, ['published'], 'deprecated', {
        deprecatedAt: at,
      });
    }

    const published = await setProductTypeLifecycleIfIn(
      tx,
      definition.id,
      PRODUCT_TYPE_EDITABLE_LIFECYCLES,
      'published',
      { publishedByOxyUserId: input.publishedByOxyUserId, publishedAt: at },
    );
    if (published === null) {
      // The CAS lost: somebody published or deprecated this version between the
      // read above and here. The empty result set IS that answer.
      return refused(
        'not_publishable_from_this_lifecycle',
        `${definition.key} v${definition.version} changed lifecycle while it was being published.`,
      );
    }

    return { outcome: 'published', definition: published };
  });
}

function toDefinitionSummary(row: ProductTypeDefinitionRow): ProductTypeDefinitionSummary {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    lifecycle: row.lifecycle,
    name: row.name,
    description: row.description ?? null,
    pendingProposalPolicy: row.pendingProposalPolicy,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    deprecatedAt: row.deprecatedAt === null ? null : row.deprecatedAt.toISOString(),
  };
}

function toGroupSummary(row: ProductTypeFieldGroupRow): ProductTypeFieldGroupSummary {
  return { id: row.id, key: row.key, label: row.label, position: row.position };
}

/**
 * The field projection, which NAMES every property it emits.
 *
 * The `provider_accounts` device (#46): a `select()` spread would carry whatever
 * a later column adds, and the thing this domain must never emit is a value
 * type, a unit family or a bound — #94 owns those, and a consumer reading one
 * from here would be reading a copy that has no way to stay in step.
 */
function toFieldSummary(row: ProductTypeFieldRow): ProductTypeFieldSummary {
  return {
    id: row.id,
    attributeDefinitionId: row.attributeDefinitionId,
    attributeKey: row.attributeKey,
    attributeVersion: row.attributeDefinitionVersion,
    groupId: row.groupId ?? null,
    scope: row.scope,
    flow: row.flow,
    requirement: row.requirement,
    valuePolicy: row.valuePolicy,
    variantCapable: row.variantCapable,
    position: row.position,
    visibilityRule: row.visibilityRule ?? null,
  };
}

function toScopeSummary(row: ProductTypeCategoryScopeRow): ProductTypeCategoryScopeSummary {
  return {
    id: row.id,
    categoryId: row.categoryId,
    includeDescendants: row.includeDescendants,
  };
}

/**
 * One version resolved for one flow.
 *
 * Deliberately not called an authoring schema: ADR 0007 D10 gives that name to a
 * composition over this PLUS the registry versions, the controlled-value
 * policies, the store permissions, the locale and the market, and it belongs to
 * `services/catalog-authoring/`. This is the product-type half, and it resolves
 * no attribute meaning at all — every field cites a registry version and the
 * authoring service is what joins it.
 */
export async function resolveProductTypeVersionView(
  db: DatabaseOrTransaction,
  definitionId: string,
  flow: ProductTypeAuthoringFlow,
): Promise<ProductTypeVersionView | null> {
  const definition = await findProductTypeDefinitionById(db, definitionId);
  if (definition === null) return null;

  const [groups, fields, scopes] = await Promise.all([
    listProductTypeFieldGroups(db, definition.id),
    listProductTypeFields(db, definition.id, flow),
    listProductTypeCategoryScopes(db, definition.id),
  ]);

  return {
    definition: toDefinitionSummary(definition),
    flow,
    groups: groups.map(toGroupSummary),
    fields: fields.map(toFieldSummary),
    categoryScopes: scopes.map(toScopeSummary),
  };
}
