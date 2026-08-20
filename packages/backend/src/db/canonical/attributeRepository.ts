/**
 * Reads and writes for the normalized attribute VALUES, the canonical images
 * and the per-field provenance (#56, extended by #94).
 *
 * Three tables in one module because they share a shape and a rule: each is an
 * ANNOTATION of a canonical entity carrying the observation it came from, and
 * each addresses its entity through nullable foreign keys plus a CHECK that
 * exactly one is set (the `commerce_relationships` pattern, ADR 0002 D17). That
 * shape is why every helper here takes an explicit grain rather than a
 * `{kind, id}` pair a caller could get half-right.
 *
 * The attribute REGISTRY moved to `db/attributes/definitionRepository.ts` with
 * #94, which made definitions versioned. This module cites a definition version
 * and never writes one.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AttributeComponentAxis,
  AttributeNormalizationState,
  AttributeSelectionState,
  AttributeVerificationState,
  CanonicalImageStatus,
  CurrencyCode,
  SourceLinkMethod,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  canonicalAttributeValues,
  canonicalFieldProvenance,
  canonicalImages,
} from '../schema/canonicalCatalog.js';

export type CanonicalAttributeValueRow = typeof canonicalAttributeValues.$inferSelect;
export type CanonicalImageRow = typeof canonicalImages.$inferSelect;
export type CanonicalFieldProvenanceRow = typeof canonicalFieldProvenance.$inferSelect;

/** Which canonical row an annotation belongs to. Exactly one, always. */
export type AnnotationGrain =
  | { readonly kind: 'family'; readonly id: string }
  | { readonly kind: 'product'; readonly id: string }
  | { readonly kind: 'variant'; readonly id: string };

export interface UpsertAttributeValueInput {
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>;
  attributeKey: string;
  sourceDisplayValue: string;
  sourceRecordId: string;
  normalizationState: AttributeNormalizationState;
  normalizationRuleVersion: string;
  method: SourceLinkMethod;
  attributeDefinitionId?: string;
  definitionVersion?: number;
  sourceUnit?: string;
  normalizedText?: string;
  normalizedNumber?: number;
  normalizedNumberMax?: number;
  rangeLowerInclusive?: boolean;
  rangeUpperInclusive?: boolean;
  normalizedUnit?: string;
  normalizedBoolean?: boolean;
  normalizedDate?: Date;
  normalizedAmountMinor?: number;
  normalizedCurrency?: CurrencyCode;
  componentAxis?: AttributeComponentAxis;
  position?: number;
  locale?: string;
  observedAt?: Date;
  confidence?: number;
}

/**
 * Record one attribute FACT.
 *
 * Converges on `(entity, key, source_record, value_slot)` — re-applying an
 * identical observation writes nothing. A DIFFERENT source asserting a different
 * value is a second row, deliberately: the disagreement is the fact, and
 * resolving it is an operator's job or nobody's.
 *
 * The SLOT is in the key because one observation legitimately produces several
 * rows: a dimensions reading is three facts with three axes, and a ports reading
 * is a set. Without it the second component of one observation would be absorbed
 * as a duplicate of the first, silently.
 *
 * `value_slot` is a GENERATED column, so the conflict target names it and
 * Postgres computes it — a caller cannot supply a slot that disagrees with the
 * axis and position it actually wrote.
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
      definitionVersion: input.definitionVersion ?? null,
      attributeKey: input.attributeKey,
      sourceDisplayValue: input.sourceDisplayValue,
      sourceUnit: input.sourceUnit ?? null,
      normalizedText: input.normalizedText ?? null,
      normalizedNumber: input.normalizedNumber ?? null,
      normalizedNumberMax: input.normalizedNumberMax ?? null,
      rangeLowerInclusive: input.rangeLowerInclusive ?? null,
      rangeUpperInclusive: input.rangeUpperInclusive ?? null,
      normalizedUnit: input.normalizedUnit ?? null,
      normalizedBoolean: input.normalizedBoolean ?? null,
      normalizedDate: input.normalizedDate ?? null,
      normalizedAmountMinor: input.normalizedAmountMinor ?? null,
      normalizedCurrency: input.normalizedCurrency ?? null,
      componentAxis: input.componentAxis ?? null,
      position: input.position ?? 0,
      locale: input.locale ?? null,
      normalizationState: input.normalizationState,
      normalizationRuleVersion: input.normalizationRuleVersion,
      method: input.method,
      sourceRecordId: input.sourceRecordId,
      observedAt: input.observedAt ?? null,
      confidence: input.confidence ?? null,
    })
    .onConflictDoNothing({
      target: isProduct
        ? [
            canonicalAttributeValues.productId,
            canonicalAttributeValues.attributeKey,
            canonicalAttributeValues.sourceRecordId,
            canonicalAttributeValues.valueSlot,
          ]
        : [
            canonicalAttributeValues.variantId,
            canonicalAttributeValues.attributeKey,
            canonicalAttributeValues.sourceRecordId,
            canonicalAttributeValues.valueSlot,
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

/**
 * Every recorded value for one entity, across every attribute key.
 *
 * ORDERED BY `position` FIRST, and the two columns after it are a real tiebreak
 * rather than decoration. `created_at` alone supplies NO ordering here: it
 * defaults to `date_trunc('milliseconds', now())`, `now()` is transaction-scoped,
 * and one observation writes every value of a multi-valued attribute inside ONE
 * transaction (`attribute-observation.service.ts` loops `applyOneFact` in `tx`).
 * Measured against the real DDL — three values written in one transaction share
 * exactly one `created_at`.
 *
 * With no ordering among them Postgres returns heap order, so a single UPDATE
 * moves a row to the end. `setAttributeValueSelectionState` is exactly that
 * UPDATE, on the ordinary observation path: promoting a value silently reordered
 * this list while every `position` stayed put. Both consumers are read surfaces
 * — `toPublicCanonicalProduct` and `comparison.service`, and the latter's
 * `TableAttributeFact` carries no `position`, so array order is its only carrier.
 *
 * `listCanonicalImages` below has had `position, id` all along; this is the same
 * rule applied to the sibling read that was missing it. `created_at` is kept
 * between the two so that candidates sharing one position stay oldest-first,
 * which is the ordering this function already intended.
 */
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
    .orderBy(
      asc(canonicalAttributeValues.attributeKey),
      asc(canonicalAttributeValues.position),
      asc(canonicalAttributeValues.createdAt),
      asc(canonicalAttributeValues.id),
    );
}

/**
 * Demote the currently selected value for one attribute SLOT of one entity.
 *
 * Slot-scoped rather than key-scoped, matching the partial unique: a `set`
 * attribute legitimately shows several values at once, and clearing them all to
 * select one would leave a product listing one port.
 */
export async function clearAttributeValueSelection(
  db: DatabaseOrTransaction,
  grain: Extract<AnnotationGrain, { kind: 'product' | 'variant' }>,
  attributeKey: string,
  valueSlot: string,
): Promise<void> {
  const owner =
    grain.kind === 'product'
      ? eq(canonicalAttributeValues.productId, grain.id)
      : eq(canonicalAttributeValues.variantId, grain.id);
  await db
    .update(canonicalAttributeValues)
    .set({ selectionState: 'superseded' })
    .where(
      and(
        owner,
        eq(canonicalAttributeValues.attributeKey, attributeKey),
        eq(canonicalAttributeValues.valueSlot, valueSlot),
        eq(canonicalAttributeValues.selectionState, 'selected'),
      ),
    );
}

export async function setAttributeValueSelectionState(
  db: DatabaseOrTransaction,
  id: string,
  selectionState: AttributeSelectionState,
): Promise<CanonicalAttributeValueRow | undefined> {
  const rows = await db
    .update(canonicalAttributeValues)
    .set({ selectionState })
    .where(eq(canonicalAttributeValues.id, id))
    .returning();
  return rows[0];
}

/**
 * Mark a set of rows `conflicting` — the disagreement, recorded as such.
 *
 * The normalized columns are deliberately LEFT INTACT, unlike #56's version,
 * which blanked them by folding `conflicting` into the normalization state. Both
 * readings survive because both are facts: each row still says what its source
 * said and what that normalized to, and the SELECTION says Mercaria shows
 * neither. Erasing the parse would make the operator resolving the conflict
 * unable to see what they were choosing between.
 */
export async function markAttributeValuesConflicting(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(canonicalAttributeValues)
    .set({ selectionState: 'conflicting' })
    .where(inArray(canonicalAttributeValues.id, [...ids]));
}

/** Raise a value's verification state — corroboration, or an operator's decision. */
export async function setAttributeValueVerification(
  db: DatabaseOrTransaction,
  ids: readonly string[],
  verificationState: AttributeVerificationState,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(canonicalAttributeValues)
    .set({ verificationState })
    .where(inArray(canonicalAttributeValues.id, [...ids]));
}

/**
 * Every entity carrying any value for one attribute key.
 *
 * The input to a definition change's re-index fan-out. `distinct` on each grain
 * separately rather than one query with a coalesce, because the two columns are
 * two different key spaces and coalescing them would make a product id and a
 * variant id indistinguishable in the result.
 */
export async function listEntityIdsWithAttribute(
  db: DatabaseOrTransaction,
  attributeKey: string,
): Promise<{ kind: 'product' | 'variant'; id: string }[]> {
  const products = await db
    .selectDistinct({ id: canonicalAttributeValues.productId })
    .from(canonicalAttributeValues)
    .where(
      and(
        eq(canonicalAttributeValues.attributeKey, attributeKey),
        sql`${canonicalAttributeValues.productId} is not null`,
      ),
    );
  const variants = await db
    .selectDistinct({ id: canonicalAttributeValues.variantId })
    .from(canonicalAttributeValues)
    .where(
      and(
        eq(canonicalAttributeValues.attributeKey, attributeKey),
        sql`${canonicalAttributeValues.variantId} is not null`,
      ),
    );

  const entities: { kind: 'product' | 'variant'; id: string }[] = [];
  for (const row of products) if (row.id !== null) entities.push({ kind: 'product', id: row.id });
  for (const row of variants) if (row.id !== null) entities.push({ kind: 'variant', id: row.id });
  return entities;
}

/** Every SELECTED value for a set of entities — what a read surface renders. */
export async function listSelectedAttributeValues(
  db: DatabaseOrTransaction,
  grain: 'product' | 'variant',
  entityIds: readonly string[],
): Promise<CanonicalAttributeValueRow[]> {
  if (entityIds.length === 0) return [];
  const owner =
    grain === 'product'
      ? inArray(canonicalAttributeValues.productId, [...entityIds])
      : inArray(canonicalAttributeValues.variantId, [...entityIds]);
  return db
    .select()
    .from(canonicalAttributeValues)
    .where(and(owner, eq(canonicalAttributeValues.selectionState, 'selected')))
    .orderBy(asc(canonicalAttributeValues.attributeKey), asc(canonicalAttributeValues.position));
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
