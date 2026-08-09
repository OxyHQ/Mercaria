/**
 * Reads and writes for the attribute registry, the normalized attribute values,
 * the canonical images and the per-field provenance (#56).
 *
 * Four tables in one module because they share a shape and a rule: each is an
 * ANNOTATION of a canonical entity carrying the observation it came from, and
 * each addresses its entity through nullable foreign keys plus a CHECK that
 * exactly one is set (the `commerce_relationships` pattern, ADR 0002 D17). That
 * shape is why every helper here takes an explicit grain rather than a
 * `{kind, id}` pair a caller could get half-right.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AttributeNormalizationState,
  AttributeValueType,
  CanonicalImageStatus,
  SourceLinkMethod,
  UnitFamily,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  canonicalAttributeValues,
  canonicalFieldProvenance,
  canonicalImages,
} from '../schema/canonicalCatalog.js';

export type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect;
export type AttributeDefinitionCategoryRow = typeof attributeDefinitionCategories.$inferSelect;
export type CanonicalAttributeValueRow = typeof canonicalAttributeValues.$inferSelect;
export type CanonicalImageRow = typeof canonicalImages.$inferSelect;
export type CanonicalFieldProvenanceRow = typeof canonicalFieldProvenance.$inferSelect;

/** Which canonical row an annotation belongs to. Exactly one, always. */
export type AnnotationGrain =
  | { readonly kind: 'family'; readonly id: string }
  | { readonly kind: 'product'; readonly id: string }
  | { readonly kind: 'variant'; readonly id: string };

export interface InsertAttributeDefinitionInput {
  key: string;
  label: string;
  valueType: AttributeValueType;
  unitFamily?: UnitFamily;
  baseUnit?: string;
  allowedValues?: string[];
  description?: string;
}

export async function insertAttributeDefinition(
  db: DatabaseOrTransaction,
  input: InsertAttributeDefinitionInput,
): Promise<AttributeDefinitionRow> {
  const rows = await db
    .insert(attributeDefinitions)
    .values({
      key: input.key,
      label: input.label,
      valueType: input.valueType,
      unitFamily: input.unitFamily ?? null,
      baseUnit: input.baseUnit ?? null,
      allowedValues: input.allowedValues ?? [],
      description: input.description ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertAttributeDefinition returned no row.');
  return row;
}

export async function findAttributeDefinitionByKey(
  db: DatabaseOrTransaction,
  key: string,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .select()
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.key, key))
    .limit(1);
  return rows[0];
}

export async function findAttributeDefinitionsByKeys(
  db: DatabaseOrTransaction,
  keys: readonly string[],
): Promise<AttributeDefinitionRow[]> {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(attributeDefinitions)
    .where(inArray(attributeDefinitions.key, [...keys]));
}

export async function listAttributeDefinitions(
  db: DatabaseOrTransaction,
): Promise<AttributeDefinitionRow[]> {
  return db.select().from(attributeDefinitions).orderBy(asc(attributeDefinitions.key));
}

export async function setAttributeDefinitionActive(
  db: DatabaseOrTransaction,
  id: string,
  isActive: boolean,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .update(attributeDefinitions)
    .set({ isActive })
    .where(eq(attributeDefinitions.id, id))
    .returning();
  return rows[0];
}

/** Scope a definition to a category. Converges on the pair's unique. */
export async function addAttributeDefinitionCategory(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  categoryId: string,
): Promise<AttributeDefinitionCategoryRow | undefined> {
  const rows = await db
    .insert(attributeDefinitionCategories)
    .values({ attributeDefinitionId, categoryId })
    .onConflictDoNothing({
      target: [
        attributeDefinitionCategories.attributeDefinitionId,
        attributeDefinitionCategories.categoryId,
      ],
    })
    .returning();
  return rows[0];
}

export async function listAttributeDefinitionCategories(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ categoryId: attributeDefinitionCategories.categoryId })
    .from(attributeDefinitionCategories)
    .where(eq(attributeDefinitionCategories.attributeDefinitionId, attributeDefinitionId))
    .orderBy(asc(attributeDefinitionCategories.categoryId));
  return rows.map((row) => row.categoryId);
}

/**
 * Definitions that apply to a category: those scoped to it, plus every UNSCOPED
 * definition. Absence of a scope row means "applies anywhere" (see the table's
 * doc comment), so a query that only joined the scope table would answer with
 * the general attributes missing.
 */
export async function listAttributeDefinitionsForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<AttributeDefinitionRow[]> {
  const scoped = db
    .select({ id: attributeDefinitionCategories.attributeDefinitionId })
    .from(attributeDefinitionCategories)
    .where(eq(attributeDefinitionCategories.categoryId, categoryId));
  const anyScope = db
    .select({ id: attributeDefinitionCategories.attributeDefinitionId })
    .from(attributeDefinitionCategories);

  return db
    .select()
    .from(attributeDefinitions)
    .where(
      and(
        eq(attributeDefinitions.isActive, true),
        sql`(${attributeDefinitions.id} in ${scoped} or ${attributeDefinitions.id} not in ${anyScope})`,
      ),
    )
    .orderBy(asc(attributeDefinitions.key));
}

export interface UpsertAttributeValueInput {
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>;
  attributeKey: string;
  sourceDisplayValue: string;
  sourceRecordId: string;
  normalizationState: AttributeNormalizationState;
  attributeDefinitionId?: string;
  normalizedText?: string;
  normalizedNumber?: number;
  normalizedUnit?: string;
  normalizedBoolean?: boolean;
  confidence?: number;
}

/**
 * Record one attribute FACT.
 *
 * Converges on `(entity, key, source_record)` — re-applying an identical
 * observation writes nothing. A DIFFERENT source asserting a different value is
 * a second row, deliberately: the disagreement is the fact, and resolving it is
 * `markAttributeValueSelected`'s job or nobody's.
 */
export async function upsertAttributeValue(
  db: DatabaseOrTransaction,
  input: UpsertAttributeValueInput,
): Promise<CanonicalAttributeValueRow | undefined> {
  const isProduct = input.grain.kind === 'product';
  const rows = await db
    .insert(canonicalAttributeValues)
    .values({
      productId: isProduct ? input.grain.id : null,
      variantId: isProduct ? null : input.grain.id,
      attributeDefinitionId: input.attributeDefinitionId ?? null,
      attributeKey: input.attributeKey,
      sourceDisplayValue: input.sourceDisplayValue,
      normalizedText: input.normalizedText ?? null,
      normalizedNumber: input.normalizedNumber ?? null,
      normalizedUnit: input.normalizedUnit ?? null,
      normalizedBoolean: input.normalizedBoolean ?? null,
      normalizationState: input.normalizationState,
      sourceRecordId: input.sourceRecordId,
      confidence: input.confidence ?? null,
    })
    .onConflictDoNothing({
      target: isProduct
        ? [
            canonicalAttributeValues.productId,
            canonicalAttributeValues.attributeKey,
            canonicalAttributeValues.sourceRecordId,
          ]
        : [
            canonicalAttributeValues.variantId,
            canonicalAttributeValues.attributeKey,
            canonicalAttributeValues.sourceRecordId,
          ],
      where: isProduct
        ? sql`${canonicalAttributeValues.productId} is not null`
        : sql`${canonicalAttributeValues.variantId} is not null`,
    })
    .returning();
  return rows[0];
}

export async function findAttributeValueById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CanonicalAttributeValueRow | undefined> {
  const rows = await db
    .select()
    .from(canonicalAttributeValues)
    .where(eq(canonicalAttributeValues.id, id))
    .limit(1);
  return rows[0];
}

/** Every recorded value for one attribute of one entity, oldest first. */
export async function listAttributeValuesForKey(
  db: DatabaseOrTransaction,
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>,
  attributeKey: string,
): Promise<CanonicalAttributeValueRow[]> {
  const owner =
    grain.kind === 'product'
      ? eq(canonicalAttributeValues.productId, grain.id)
      : eq(canonicalAttributeValues.variantId, grain.id);
  return db
    .select()
    .from(canonicalAttributeValues)
    .where(and(owner, eq(canonicalAttributeValues.attributeKey, attributeKey)))
    .orderBy(asc(canonicalAttributeValues.createdAt), asc(canonicalAttributeValues.id));
}

export async function listAttributeValues(
  db: DatabaseOrTransaction,
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>,
): Promise<CanonicalAttributeValueRow[]> {
  const owner =
    grain.kind === 'product'
      ? eq(canonicalAttributeValues.productId, grain.id)
      : eq(canonicalAttributeValues.variantId, grain.id);
  return db
    .select()
    .from(canonicalAttributeValues)
    .where(owner)
    .orderBy(asc(canonicalAttributeValues.attributeKey), asc(canonicalAttributeValues.createdAt));
}

/** Clear the selection for one attribute of one entity. */
export async function clearAttributeValueSelection(
  db: DatabaseOrTransaction,
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>,
  attributeKey: string,
): Promise<void> {
  const owner =
    grain.kind === 'product'
      ? eq(canonicalAttributeValues.productId, grain.id)
      : eq(canonicalAttributeValues.variantId, grain.id);
  await db
    .update(canonicalAttributeValues)
    .set({ selected: false })
    .where(
      and(
        owner,
        eq(canonicalAttributeValues.attributeKey, attributeKey),
        eq(canonicalAttributeValues.selected, true),
      ),
    );
}

export async function setAttributeValueSelected(
  db: DatabaseOrTransaction,
  id: string,
  selected: boolean,
): Promise<CanonicalAttributeValueRow | undefined> {
  const rows = await db
    .update(canonicalAttributeValues)
    .set({ selected })
    .where(eq(canonicalAttributeValues.id, id))
    .returning();
  return rows[0];
}

/** Mark a set of rows `conflicting` — the disagreement, recorded as such. */
export async function markAttributeValuesConflicting(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(canonicalAttributeValues)
    .set({
      normalizationState: 'conflicting',
      normalizedText: null,
      normalizedNumber: null,
      normalizedUnit: null,
      normalizedBoolean: null,
      selected: false,
    })
    .where(inArray(canonicalAttributeValues.id, [...ids]));
}

export interface InsertCanonicalImageInput {
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>;
  sourceRecordId: string;
  fileId?: string;
  sourceUrl?: string;
  alt?: string;
  locale?: string;
  position?: number;
  status?: CanonicalImageStatus;
}

/** Attach an image, converging on `(entity, image_ref)`. */
export async function insertCanonicalImage(
  db: DatabaseOrTransaction,
  input: InsertCanonicalImageInput,
): Promise<CanonicalImageRow | undefined> {
  const isProduct = input.grain.kind === 'product';
  const rows = await db
    .insert(canonicalImages)
    .values({
      productId: isProduct ? input.grain.id : null,
      variantId: isProduct ? null : input.grain.id,
      fileId: input.fileId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceRecordId: input.sourceRecordId,
      alt: input.alt ?? null,
      locale: input.locale ?? null,
      position: input.position ?? 0,
      status: input.status ?? 'active',
    })
    .onConflictDoNothing({
      target: isProduct
        ? [canonicalImages.productId, canonicalImages.imageRef]
        : [canonicalImages.variantId, canonicalImages.imageRef],
      where: isProduct
        ? sql`${canonicalImages.productId} is not null`
        : sql`${canonicalImages.variantId} is not null`,
    })
    .returning();
  return rows[0];
}

export async function listCanonicalImages(
  db: DatabaseOrTransaction,
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>,
): Promise<CanonicalImageRow[]> {
  const owner =
    grain.kind === 'product'
      ? eq(canonicalImages.productId, grain.id)
      : eq(canonicalImages.variantId, grain.id);
  return db
    .select()
    .from(canonicalImages)
    .where(owner)
    .orderBy(asc(canonicalImages.position), asc(canonicalImages.id));
}

export interface RecordFieldProvenanceInput {
  grain: AnnotationGrain;
  field: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  confidence?: number;
  decidedByOxyUserId?: string;
  selectedAt: Date;
}

/**
 * Record where a selected canonical field came from.
 *
 * `DO UPDATE` on the per-entity unique, unlike every other write in this domain:
 * a field's provenance is not an accumulating history but a statement about the
 * value stored RIGHT NOW, so re-selecting the field from a newer observation
 * must move it. The history of what a source once said lives where it belongs —
 * in the `source_records` rows themselves, which are append-only.
 */
export async function recordFieldProvenance(
  db: DatabaseOrTransaction,
  input: RecordFieldProvenanceInput,
): Promise<CanonicalFieldProvenanceRow> {
  const values = {
    familyId: input.grain.kind === 'family' ? input.grain.id : null,
    productId: input.grain.kind === 'product' ? input.grain.id : null,
    variantId: input.grain.kind === 'variant' ? input.grain.id : null,
    field: input.field,
    sourceRecordId: input.sourceRecordId,
    method: input.method,
    confidence: input.confidence ?? null,
    decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    selectedAt: input.selectedAt,
  };
  const targetColumn =
    input.grain.kind === 'family'
      ? canonicalFieldProvenance.familyId
      : input.grain.kind === 'product'
        ? canonicalFieldProvenance.productId
        : canonicalFieldProvenance.variantId;
  const targetPredicate =
    input.grain.kind === 'family'
      ? sql`${canonicalFieldProvenance.familyId} is not null`
      : input.grain.kind === 'product'
        ? sql`${canonicalFieldProvenance.productId} is not null`
        : sql`${canonicalFieldProvenance.variantId} is not null`;

  const rows = await db
    .insert(canonicalFieldProvenance)
    .values(values)
    .onConflictDoUpdate({
      target: [targetColumn, canonicalFieldProvenance.field],
      targetWhere: targetPredicate,
      set: {
        sourceRecordId: values.sourceRecordId,
        method: values.method,
        confidence: values.confidence,
        decidedByOxyUserId: values.decidedByOxyUserId,
        selectedAt: values.selectedAt,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('recordFieldProvenance returned no row.');
  return row;
}

export async function listFieldProvenance(
  db: DatabaseOrTransaction,
  grain: AnnotationGrain,
): Promise<CanonicalFieldProvenanceRow[]> {
  const owner =
    grain.kind === 'family'
      ? eq(canonicalFieldProvenance.familyId, grain.id)
      : grain.kind === 'product'
        ? eq(canonicalFieldProvenance.productId, grain.id)
        : eq(canonicalFieldProvenance.variantId, grain.id);
  return db
    .select()
    .from(canonicalFieldProvenance)
    .where(owner)
    .orderBy(asc(canonicalFieldProvenance.field));
}

/** The provenance of ONE field, when it has any. */
export async function findFieldProvenance(
  db: DatabaseOrTransaction,
  grain: AnnotationGrain,
  field: string,
): Promise<CanonicalFieldProvenanceRow | undefined> {
  const owner =
    grain.kind === 'family'
      ? eq(canonicalFieldProvenance.familyId, grain.id)
      : grain.kind === 'product'
        ? eq(canonicalFieldProvenance.productId, grain.id)
        : eq(canonicalFieldProvenance.variantId, grain.id);
  const rows = await db
    .select()
    .from(canonicalFieldProvenance)
    .where(and(owner, eq(canonicalFieldProvenance.field, field)))
    .limit(1);
  return rows[0];
}
