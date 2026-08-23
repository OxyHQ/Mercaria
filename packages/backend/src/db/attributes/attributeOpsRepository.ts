/**
 * Reads and writes for the attribute domain's OPERATIONAL tables (#94 coverage
 * rules 1, 2, 4, 5 and 8): source mappings, the review queue, the reindex
 * request log, and the completeness measurement.
 *
 * Coverage is a QUERY here, not a table. The reasoning is recorded in
 * `schema/attributeRegistry.ts`: a stored completeness number is a second
 * representation of a fact the values already carry, and it is stale the moment
 * an observation lands.
 */

import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  AttributeCoverageCell,
  AttributeEntityKind,
  AttributeReindexReason,
  AttributeReviewReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  attributeReindexRequests,
  attributeSourceMappings,
  attributeValueReviews,
} from '../schema/attributeRegistry.js';
import { canonicalAttributeValues, canonicalProducts } from '../schema/canonicalCatalog.js';
import { sourceRecords } from '../schema/provenance.js';

export type AttributeSourceMappingRow = typeof attributeSourceMappings.$inferSelect;
export type AttributeValueReviewRow = typeof attributeValueReviews.$inferSelect;
export type AttributeReindexRequestRow = typeof attributeReindexRequests.$inferSelect;

export async function upsertAttributeSourceMapping(
  db: DatabaseOrTransaction,
  input: typeof attributeSourceMappings.$inferInsert,
): Promise<AttributeSourceMappingRow> {
  const rows = await db
    .insert(attributeSourceMappings)
    .values(input)
    .onConflictDoUpdate({
      target: [attributeSourceMappings.catalogSourceId, attributeSourceMappings.sourceField],
      set: {
        attributeKey: input.attributeKey,
        assumedUnit: input.assumedUnit ?? null,
        componentAxis: input.componentAxis ?? null,
        categoryIds: input.categoryIds ?? [],
        note: input.note ?? null,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertAttributeSourceMapping returned no row.');
  return row;
}

export async function findAttributeSourceMapping(
  db: DatabaseOrTransaction,
  catalogSourceId: string,
  sourceField: string,
): Promise<AttributeSourceMappingRow | undefined> {
  const rows = await db
    .select()
    .from(attributeSourceMappings)
    .where(
      and(
        eq(attributeSourceMappings.catalogSourceId, catalogSourceId),
        eq(attributeSourceMappings.sourceField, sourceField.trim().toLowerCase()),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface OpenAttributeReviewInput {
  entityKind: AttributeEntityKind;
  entityId: string;
  attributeKey: string;
  definitionVersion: number;
  reason: AttributeReviewReason;
  priority: number;
  summary: string;
}

/**
 * Open a review, or converge on the one already open.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique — a genuine no-op on a
 * repeat, so two ingestion workers observing the same conflict do not produce
 * two rows and a reviewer does not resolve half a disagreement. The empty
 * `RETURNING` set IS the "already open" answer, the moderation-event shape.
 *
 * The `where` repeats the index's predicate because Postgres refuses to infer a
 * PARTIAL index's arbiter without it (`there is no unique or exclusion
 * constraint matching the ON CONFLICT specification`) — the `ensureCart` lesson,
 * one domain over.
 */
export async function openAttributeReview(
  db: DatabaseOrTransaction,
  input: OpenAttributeReviewInput,
): Promise<AttributeValueReviewRow | undefined> {
  const rows = await db
    .insert(attributeValueReviews)
    .values({ ...input, state: 'open' })
    .onConflictDoNothing({
      target: [
        attributeValueReviews.entityKind,
        attributeValueReviews.entityId,
        attributeValueReviews.attributeKey,
      ],
      where: sql`${attributeValueReviews.state} = 'open'`,
    })
    .returning();
  return rows[0];
}

/** Close a review. A CAS on `open`, so a second reviewer's click is a no-op. */
export async function closeAttributeReview(
  db: DatabaseOrTransaction,
  id: string,
  resolution: {
    state: 'resolved' | 'dismissed';
    resolvedByOxyUserId: string;
    resolvedValueId?: string;
  },
): Promise<AttributeValueReviewRow | undefined> {
  const rows = await db
    .update(attributeValueReviews)
    .set({
      state: resolution.state,
      resolvedByOxyUserId: resolution.resolvedByOxyUserId,
      resolvedValueId: resolution.resolvedValueId ?? null,
      resolvedAt: new Date(),
    })
    .where(and(eq(attributeValueReviews.id, id), eq(attributeValueReviews.state, 'open')))
    .returning();
  return rows[0];
}

/**
 * The queue an operator works, highest priority and oldest first.
 *
 * `id` is the third ordering term and it is load-bearing, not decoration.
 * `priority` is `integer().notNull().default(0)` and `created_at` defaults to
 * `date_trunc('milliseconds', now())` — where `now()` is the TRANSACTION
 * timestamp, so a bulk enqueue writes every row it creates with a byte-identical
 * sort key. This read is OFFSET-paginated, and an offset page over an ordering
 * that ties is the one shape that both REPEATS a row on one page and DROPS
 * another for good: the database is free to order the tied block differently
 * between the query for page one and the query for page two. A dropped row here
 * is a review nobody ever works.
 *
 * The primary key breaks every remaining tie, which makes the order total.
 * `attribute_value_reviews_queue_idx (state, priority desc, created_at)` still
 * serves the leading terms, so this costs no plan change.
 */
export async function listOpenAttributeReviews(
  db: DatabaseOrTransaction,
  options: { attributeKey?: string; limit: number; offset: number },
): Promise<AttributeValueReviewRow[]> {
  const filters = [eq(attributeValueReviews.state, 'open')];
  if (options.attributeKey !== undefined) {
    filters.push(eq(attributeValueReviews.attributeKey, options.attributeKey));
  }
  return db
    .select()
    .from(attributeValueReviews)
    .where(and(...filters))
    .orderBy(
      desc(attributeValueReviews.priority),
      asc(attributeValueReviews.createdAt),
      asc(attributeValueReviews.id),
    )
    .limit(options.limit)
    .offset(options.offset);
}

export async function findAttributeReviewById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<AttributeValueReviewRow | undefined> {
  const rows = await db
    .select()
    .from(attributeValueReviews)
    .where(eq(attributeValueReviews.id, id))
    .limit(1);
  return rows[0];
}

export interface EnqueueReindexInput {
  entityKind: AttributeEntityKind;
  entityId: string;
  reason: AttributeReindexReason;
  attributeKey?: string;
  definitionVersion?: number;
}

/**
 * The deterministic id of one reindex request.
 *
 * Composed from the facts that make two requests the SAME work, so a repeat
 * converges instead of queueing twice. `attributeKey` is in the key because a
 * definition change and a value change on the same entity are different work
 * for a consumer that only re-reads one field.
 */
export function reindexRequestId(input: EnqueueReindexInput): string {
  return [input.entityKind, input.entityId, input.attributeKey ?? '*', input.reason].join(':');
}

/**
 * Record that an entity needs re-indexing.
 *
 * `ON CONFLICT DO NOTHING` on the deterministic primary key: a repeat writes
 * nothing at all — no tuple version, no timestamp — which is what makes a
 * retried transaction, a re-run backfill batch and two concurrent observers
 * converge on one job. Gate the LOOP that drains this, never the record: the
 * consumer is #61's, and a request written before it exists is still correct
 * when it arrives.
 */
export async function enqueueAttributeReindex(
  db: DatabaseOrTransaction,
  input: EnqueueReindexInput,
): Promise<AttributeReindexRequestRow | undefined> {
  const rows = await db
    .insert(attributeReindexRequests)
    .values({
      id: reindexRequestId(input),
      entityKind: input.entityKind,
      entityId: input.entityId,
      attributeKey: input.attributeKey ?? null,
      definitionVersion: input.definitionVersion ?? null,
      reason: input.reason,
      enqueuedAt: new Date(),
    })
    .onConflictDoNothing({ target: attributeReindexRequests.id })
    .returning();
  return rows[0];
}

/** Pending requests, oldest first — what an operator sees and a consumer claims. */
export async function listPendingReindexRequests(
  db: DatabaseOrTransaction,
  limit: number,
): Promise<AttributeReindexRequestRow[]> {
  return db
    .select()
    .from(attributeReindexRequests)
    .where(isNull(attributeReindexRequests.processedAt))
    .orderBy(asc(attributeReindexRequests.enqueuedAt))
    .limit(limit);
}

/** One facet bucket as the aggregate produces it, before labelling. */
export interface FacetBucketRow extends Record<string, unknown> {
  attributeKey: string;
  /** The canonical text value, or NULL for a numeric attribute. */
  bucketText: string | null;
  bucketBoolean: boolean | null;
  count: number;
}

/** The numeric span of one attribute across a category, for a range facet. */
export interface FacetRangeRow extends Record<string, unknown> {
  attributeKey: string;
  minValue: number | null;
  maxValue: number | null;
  present: number;
}

/**
 * Facet buckets for one category's PRODUCTS (#94 API rule 6).
 *
 * Only SELECTED values are counted. A conflicting or unparsed value is not a
 * fact the catalogue is willing to state, so offering it as a filter would
 * promise results the evaluator then refuses — a facet whose count does not
 * match its filter is worse than a missing facet.
 */
export async function facetBucketsForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
  attributeKeys: readonly string[],
): Promise<FacetBucketRow[]> {
  if (attributeKeys.length === 0) return [];
  const rows = await db.execute<FacetBucketRow>(sql`
    select v.attribute_key as "attributeKey",
           v.normalized_text as "bucketText",
           v.normalized_boolean as "bucketBoolean",
           count(*)::int as count
    from canonical_attribute_values v
    join canonical_products p on p.id = v.product_id
    where p.category_id = ${categoryId}
      and p.status = 'active'
      and v.selection_state = 'selected'
      and v.attribute_key = any(${sql.param([...attributeKeys])}::text[])
      and (v.normalized_text is not null or v.normalized_boolean is not null)
    group by v.attribute_key, v.normalized_text, v.normalized_boolean
    order by count(*) desc, v.attribute_key
  `);
  return [...rows];
}

/** The numeric span of each attribute across a category, for range facets. */
export async function facetRangesForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
  attributeKeys: readonly string[],
): Promise<FacetRangeRow[]> {
  if (attributeKeys.length === 0) return [];
  const rows = await db.execute<FacetRangeRow>(sql`
    select v.attribute_key as "attributeKey",
           min(v.normalized_number) as "minValue",
           max(coalesce(v.normalized_number_max, v.normalized_number)) as "maxValue",
           count(distinct v.product_id)::int as present
    from canonical_attribute_values v
    join canonical_products p on p.id = v.product_id
    where p.category_id = ${categoryId}
      and p.status = 'active'
      and v.selection_state = 'selected'
      and v.normalized_number is not null
      and v.attribute_key = any(${sql.param([...attributeKeys])}::text[])
    group by v.attribute_key
  `);
  return [...rows];
}

/** Products in a category with a SELECTED value for an attribute — the facet denominator. */
export async function countProductsInCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(canonicalProducts)
    .where(and(eq(canonicalProducts.categoryId, categoryId), eq(canonicalProducts.status, 'active')));
  return rows[0]?.total ?? 0;
}

export interface CoverageQuery {
  entityKind: AttributeEntityKind;
  categoryId?: string;
  catalogSourceId?: string;
  attributeKeys?: readonly string[];
}

/**
 * Attribute completeness for one scope (#94 coverage rule 1).
 *
 * The denominator is the number of canonical entities in scope, counted once
 * rather than per attribute — which is why it is a separate query rather than a
 * `count(*) over ()` bolted onto the per-attribute aggregate: an attribute
 * nobody has ever recorded has to report `observedCount: 0` against a real
 * denominator, and a grouped query cannot produce a row for a key that appears
 * in no value.
 *
 * `eligibleCount` therefore comes from the entity table and the per-key numbers
 * from the value table, and the caller supplies the key list. An attribute with
 * zero rows is the most interesting cell in the report; a query shape that could
 * not emit it would hide exactly the gap the report exists to find.
 */
export async function measureAttributeCoverage(
  db: DatabaseOrTransaction,
  query: CoverageQuery,
): Promise<AttributeCoverageCell[]> {
  const eligible = await countEligibleEntities(db, query);

  const entityColumn =
    query.entityKind === 'product'
      ? canonicalAttributeValues.productId
      : canonicalAttributeValues.variantId;

  const filters = [sql`${entityColumn} is not null`];
  if (query.attributeKeys !== undefined && query.attributeKeys.length > 0) {
    filters.push(inArray(canonicalAttributeValues.attributeKey, [...query.attributeKeys]));
  }
  if (query.catalogSourceId !== undefined) {
    filters.push(eq(sourceRecords.sourceId, query.catalogSourceId));
  }

  const rows = await db
    .select({
      attributeKey: canonicalAttributeValues.attributeKey,
      observed: sql<number>`count(distinct ${entityColumn})::int`,
      selected: sql<number>`count(distinct ${entityColumn}) filter (where ${canonicalAttributeValues.selectionState} = 'selected')::int`,
      conflicting: sql<number>`count(distinct ${entityColumn}) filter (where ${canonicalAttributeValues.selectionState} = 'conflicting')::int`,
      unnormalized: sql<number>`count(distinct ${entityColumn}) filter (where ${canonicalAttributeValues.normalizationState} <> 'normalized')::int`,
    })
    .from(canonicalAttributeValues)
    .innerJoin(sourceRecords, eq(sourceRecords.id, canonicalAttributeValues.sourceRecordId))
    .where(and(...filters))
    .groupBy(canonicalAttributeValues.attributeKey);

  const measured = new Map(rows.map((row) => [row.attributeKey, row]));
  const keys =
    query.attributeKeys !== undefined && query.attributeKeys.length > 0
      ? [...query.attributeKeys]
      : rows.map((row) => row.attributeKey);

  return keys.map((attributeKey) => {
    const row = measured.get(attributeKey);
    return {
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.catalogSourceId === undefined ? {} : { catalogSourceId: query.catalogSourceId }),
      attributeKey,
      entityKind: query.entityKind,
      eligibleCount: eligible,
      observedCount: row?.observed ?? 0,
      selectedCount: row?.selected ?? 0,
      conflictingCount: row?.conflicting ?? 0,
      unnormalizedCount: row?.unnormalized ?? 0,
    };
  });
}

/** The denominator: canonical entities the report is measured against. */
async function countEligibleEntities(
  db: DatabaseOrTransaction,
  query: CoverageQuery,
): Promise<number> {
  if (query.entityKind === 'product') {
    const filters = [
      or(eq(canonicalProducts.status, 'active'), eq(canonicalProducts.status, 'draft')),
    ];
    if (query.categoryId !== undefined) {
      filters.push(eq(canonicalProducts.categoryId, query.categoryId));
    }
    const rows = await db
      .select({ total: count() })
      .from(canonicalProducts)
      .where(and(...filters));
    return rows[0]?.total ?? 0;
  }

  // A variant inherits its category from its product, so the scope filter has to
  // join rather than read a column a variant does not have.
  const scoped = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from canonical_variants v
    join canonical_products p on p.id = v.product_id
    where p.status in ('active', 'draft')
      ${query.categoryId === undefined ? sql`` : sql`and p.category_id = ${query.categoryId}`}
  `);
  return [...scoped][0]?.total ?? 0;
}
