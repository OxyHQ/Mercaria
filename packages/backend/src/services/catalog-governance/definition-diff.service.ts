/**
 * Hydrating two definition versions and diffing them (#367 Workstream 12).
 *
 * The diff itself is pure (`diff.ts`); this module is the reads that feed it,
 * kept separate so every diff rule stays a table test with no database in it.
 *
 * ## The version diff is what makes a publication preview honest
 *
 * #367 asks for "schema diff and impact preview before publication", and the
 * two answer different questions that are easy to confuse. The IMPACT report
 * says how many rows point at the definition; the DIFF says what is changing
 * about it. A publication with a large impact and no breaking change is safe,
 * and one with a tiny impact and a removed required field is not — so a surface
 * that showed only one of them would be reassuring in exactly the wrong case.
 */

import type {
  CatalogDefinitionDiff,
  CatalogGovernanceSubjectKind,
  ProductTypeFieldRequirement,
} from '@mercaria/shared-types';
import { PRODUCT_TYPE_AUTHORING_FLOWS } from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProductTypeDefinitionByKeyVersion,
} from '../../db/productTypes/productTypeRepository.js';
import {
  listProductTypeCategoryScopes,
  listProductTypeFieldGroups,
  listProductTypeFields,
} from '../../db/productTypes/productTypeFieldRepository.js';
import { resolveDefinitionVersion } from '../attributes/definition-registry.service.js';
import {
  diffAttributeVersions,
  diffProductTypeVersions,
  type DiffableAttributeVersion,
  type DiffableProductTypeVersion,
} from './diff.js';

/** What a diff request states. */
export interface DefinitionDiffInput {
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly key: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * Read one product-type version into the shape the pure diff takes.
 *
 * Fields are read per FLOW and concatenated, because `listProductTypeFields`
 * takes one — a version's field set is genuinely per flow, and a diff that read
 * only the merchant flow would report every P2P-only field as removed.
 */
async function hydrateProductType(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<DiffableProductTypeVersion> {
  const definition = await findProductTypeDefinitionByKeyVersion(db, key, version);
  if (!definition) throw notFound(`Product type ${key} has no version ${String(version)}.`);

  const groups = await listProductTypeFieldGroups(db, definition.id);
  const groupKeyById = new Map(groups.map((group) => [group.id, group.key]));

  const fields: DiffableProductTypeVersion['fields'][number][] = [];
  for (const flow of PRODUCT_TYPE_AUTHORING_FLOWS) {
    for (const field of await listProductTypeFields(db, definition.id, flow)) {
      fields.push({
        attributeKey: field.attributeKey,
        scope: field.scope,
        flow: field.flow,
        requirement: field.requirement as ProductTypeFieldRequirement,
        valuePolicy: field.valuePolicy,
        variantCapable: field.variantCapable,
        attributeDefinitionVersion: field.attributeDefinitionVersion,
        // The group KEY, never its id: a group id is minted per version, so
        // diffing on ids would report every field as regrouped.
        groupKey: field.groupId === null ? null : (groupKeyById.get(field.groupId) ?? null),
      });
    }
  }

  const scopes = await listProductTypeCategoryScopes(db, definition.id);

  return {
    version: definition.version,
    fields,
    categoryIds: scopes.map((scope) => scope.categoryId).sort(),
  };
}

/** Read one attribute definition version into the shape the pure diff takes. */
async function hydrateAttribute(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<DiffableAttributeVersion> {
  const resolved = await resolveDefinitionVersion(db, key, version);
  if (!resolved) throw notFound(`Attribute ${key} has no version ${String(version)}.`);

  return {
    version: resolved.row.version,
    valueType: resolved.row.valueType,
    cardinality: resolved.row.cardinality,
    unitFamily: resolved.row.unitFamily ?? null,
    baseUnit: resolved.row.baseUnit ?? null,
    minValue: resolved.row.minValue ?? null,
    maxValue: resolved.row.maxValue ?? null,
    decimalPlaces: resolved.row.decimalPlaces ?? null,
    variantDefining: resolved.row.variantDefining,
    filterable: resolved.row.filterable,
    hardConstraintCapable: resolved.row.hardConstraintCapable,
    enumValues: resolved.enumValues.map((value) => value.value).sort(),
    categoryIds: resolved.categoryScopes.map((scope) => scope.categoryId).sort(),
  };
}

/**
 * Diff two versions of one definition.
 *
 * Refuses `fromVersion === toVersion` rather than returning an empty diff: an
 * empty diff between two DIFFERENT versions is a real and useful answer (a
 * republished version with no semantic change), and returning the same shape
 * for a mistake would make the two indistinguishable.
 */
export async function composeDefinitionDiff(
  db: DatabaseOrTransaction,
  input: DefinitionDiffInput,
): Promise<CatalogDefinitionDiff> {
  if (input.fromVersion === input.toVersion) {
    throw conflict('A diff needs two different versions.');
  }

  if (input.subjectKind === 'product_type_definition') {
    const [from, to] = await Promise.all([
      hydrateProductType(db, input.key, input.fromVersion),
      hydrateProductType(db, input.key, input.toVersion),
    ]);
    return diffProductTypeVersions(from, to);
  }

  if (input.subjectKind === 'attribute_definition') {
    const [from, to] = await Promise.all([
      hydrateAttribute(db, input.key, input.fromVersion),
      hydrateAttribute(db, input.key, input.toVersion),
    ]);
    return diffAttributeVersions(from, to);
  }

  // Categories and navigation trees are not VERSIONED definitions in the sense
  // this diff means. A category has one row and a history of redirects; a
  // navigation tree's versions are whole trees whose diff is the node set, which
  // `previewNavigationTree` already renders. Answering with an empty diff would
  // claim two versions are identical.
  throw conflict(
    `${input.subjectKind} has no versioned schema to diff. Product types and attribute definitions do; a category's history is its redirect chain and a navigation tree's is its preview.`,
  );
}
