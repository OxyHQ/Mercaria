/**
 * The three child tables of a product-type version (#367, ADR 0007 D5):
 * `product_type_field_groups`, `product_type_fields` and
 * `product_type_category_scopes`.
 *
 * ## The citation is passed WHOLE, and that is not a convenience
 *
 * Every field write takes `attributeDefinitionId`, `attributeKey` and
 * `attributeDefinitionVersion` together, because
 * `mercaria_product_type_field_citation()` refuses a row whose citation
 * disagrees with the definition its foreign key points at. A helper that
 * resolved the key and version from the id inside this file would look tidier
 * and would move the guarantee out of the database and into a call site — which
 * is the opposite of what the trigger is for. The caller states what it believes
 * it is citing; the server checks.
 *
 * ## Nothing here reads or writes a value
 *
 * These tables describe a SCHEMA. There is no function in this file that touches
 * a listing, a variant, an inventory level, a price or an offer, and
 * `product-type-isolation.test.ts` fails the build if one appears.
 */

import { and, asc, eq } from 'drizzle-orm';
import type {
  ProductTypeAuthoringFlow,
  ProductTypeFieldRequirement,
  ProductTypeFieldScope,
  ProductTypeValuePolicy,
  ProductTypeVisibilityRule,
} from '@mercaria/shared-types';
import {
  productTypeCategoryScopes,
  productTypeFieldGroups,
  productTypeFields,
} from '../schema/productTypes.js';
import type { DatabaseOrTransaction } from '../postgres.js';

export type ProductTypeFieldGroupRow = typeof productTypeFieldGroups.$inferSelect;
export type ProductTypeFieldRow = typeof productTypeFields.$inferSelect;
export type ProductTypeCategoryScopeRow = typeof productTypeCategoryScopes.$inferSelect;

export interface NewProductTypeFieldGroup {
  productTypeDefinitionId: string;
  key: string;
  label: string;
  position?: number;
}

export async function insertProductTypeFieldGroup(
  db: DatabaseOrTransaction,
  input: NewProductTypeFieldGroup,
): Promise<ProductTypeFieldGroupRow> {
  const [row] = await db
    .insert(productTypeFieldGroups)
    .values({
      productTypeDefinitionId: input.productTypeDefinitionId,
      key: input.key,
      label: input.label,
      ...(input.position === undefined ? {} : { position: input.position }),
    })
    .returning();
  return row;
}

export async function listProductTypeFieldGroups(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
): Promise<ProductTypeFieldGroupRow[]> {
  return db
    .select()
    .from(productTypeFieldGroups)
    .where(eq(productTypeFieldGroups.productTypeDefinitionId, productTypeDefinitionId))
    .orderBy(asc(productTypeFieldGroups.position), asc(productTypeFieldGroups.key));
}

/**
 * One field of one version, in one flow.
 *
 * `visibilityRule` is typed as the parsed AST rather than `unknown`: the only
 * way to obtain one from untrusted input is `parseVisibilityRule`, so the
 * signature is what routes a request body through the bounds instead of past
 * them.
 */
export interface NewProductTypeField {
  productTypeDefinitionId: string;
  groupId?: string | null;
  attributeDefinitionId: string;
  attributeKey: string;
  attributeDefinitionVersion: number;
  scope: ProductTypeFieldScope;
  flow: ProductTypeAuthoringFlow;
  requirement: ProductTypeFieldRequirement;
  valuePolicy: ProductTypeValuePolicy;
  variantCapable?: boolean;
  position?: number;
  visibilityRule?: ProductTypeVisibilityRule | null;
}

export async function insertProductTypeField(
  db: DatabaseOrTransaction,
  input: NewProductTypeField,
): Promise<ProductTypeFieldRow> {
  const [row] = await db
    .insert(productTypeFields)
    .values({
      productTypeDefinitionId: input.productTypeDefinitionId,
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      attributeDefinitionId: input.attributeDefinitionId,
      attributeKey: input.attributeKey,
      attributeDefinitionVersion: input.attributeDefinitionVersion,
      scope: input.scope,
      flow: input.flow,
      requirement: input.requirement,
      valuePolicy: input.valuePolicy,
      ...(input.variantCapable === undefined ? {} : { variantCapable: input.variantCapable }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.visibilityRule === undefined ? {} : { visibilityRule: input.visibilityRule }),
    })
    .returning();
  return row;
}

/**
 * Every field of one version for ONE flow, in layout order.
 *
 * Scoped by flow in SQL rather than filtered afterwards, because
 * `product_type_fields_layout_idx` is `(definition, flow, position)` and the
 * whole point of a per-flow row is that a P2P form is a different, shorter list
 * — not the merchant's list with rows crossed out on the client.
 */
export async function listProductTypeFields(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
  flow: ProductTypeAuthoringFlow,
): Promise<ProductTypeFieldRow[]> {
  return db
    .select()
    .from(productTypeFields)
    .where(
      and(
        eq(productTypeFields.productTypeDefinitionId, productTypeDefinitionId),
        eq(productTypeFields.flow, flow),
      ),
    )
    .orderBy(asc(productTypeFields.position), asc(productTypeFields.attributeKey));
}

/**
 * Every field of one version, across EVERY flow, in layout order.
 *
 * The public specification layout needs this and cannot use the per-flow read: a
 * shopper's spec table must not be grouped differently depending on which
 * authoring form the seller filled in, so its grouping is derived over all flows
 * at once. Five per-flow reads would answer the same question in five round
 * trips and would additionally make "did any flow group this attribute" a
 * property of the loop rather than of the data.
 *
 * The flow is still on every row: the derivation has to be able to see that two
 * flows placed one attribute in two groups, which is exactly the case it refuses
 * to resolve.
 */
export async function listProductTypeFieldsForEveryFlow(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
): Promise<ProductTypeFieldRow[]> {
  return db
    .select()
    .from(productTypeFields)
    .where(eq(productTypeFields.productTypeDefinitionId, productTypeDefinitionId))
    .orderBy(asc(productTypeFields.position), asc(productTypeFields.attributeKey));
}

/**
 * The declared variant axes of one version — every field marked
 * `variant_capable`, across every flow.
 *
 * Deduplication is unnecessary and would be wrong to add: the citation trigger
 * already refuses two flows that disagree about `variant_capable`, so the set of
 * variant-capable ATTRIBUTES is the same whichever flow is read. Callers that
 * want the attribute set read one flow.
 */
export async function listVariantCapableFields(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
  flow: ProductTypeAuthoringFlow,
): Promise<ProductTypeFieldRow[]> {
  return db
    .select()
    .from(productTypeFields)
    .where(
      and(
        eq(productTypeFields.productTypeDefinitionId, productTypeDefinitionId),
        eq(productTypeFields.flow, flow),
        eq(productTypeFields.variantCapable, true),
      ),
    )
    .orderBy(asc(productTypeFields.position));
}

export async function insertProductTypeCategoryScope(
  db: DatabaseOrTransaction,
  input: { productTypeDefinitionId: string; categoryId: string; includeDescendants?: boolean },
): Promise<ProductTypeCategoryScopeRow> {
  const [row] = await db
    .insert(productTypeCategoryScopes)
    .values({
      productTypeDefinitionId: input.productTypeDefinitionId,
      categoryId: input.categoryId,
      ...(input.includeDescendants === undefined
        ? {}
        : { includeDescendants: input.includeDescendants }),
    })
    .returning();
  return row;
}

export async function listProductTypeCategoryScopes(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
): Promise<ProductTypeCategoryScopeRow[]> {
  return db
    .select()
    .from(productTypeCategoryScopes)
    .where(eq(productTypeCategoryScopes.productTypeDefinitionId, productTypeDefinitionId))
    .orderBy(asc(productTypeCategoryScopes.categoryId));
}

/**
 * Delete one field. Permitted only while the parent version is still editable —
 * enforced by `product_type_fields_frozen`, not by a predicate here, because a
 * predicate here would be a second answer to a question the trigger already
 * answers for every writer.
 */
export async function deleteProductTypeField(
  db: DatabaseOrTransaction,
  id: string,
): Promise<boolean> {
  const rows = await db.delete(productTypeFields).where(eq(productTypeFields.id, id)).returning();
  return rows.length > 0;
}
