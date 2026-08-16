/**
 * `generic_compatibility_relations` — the reads and the one write path (#367
 * step 8, ADR 0007 D8).
 *
 * The forward read answers "what does this fit"; the reverse read answers
 * "what fits this", which D8 requires to be an INDEXED read rather than a scan.
 * Both are one statement against one partial index, which is why the reverse
 * lookup takes a target as a discriminated union rather than four optional
 * parameters: the union decides which index the statement uses, and an
 * ambiguous call is unrepresentable rather than answered from whichever column
 * happened to be set.
 *
 * ## There is no writer for a variant option in this file, and there cannot be
 *
 * It imports the compatibility schema and nothing else from `db/schema`. That
 * is the whole of the guarantee ADR 0007 D8's acceptance scenario rests on, and
 * `compatibility-isolation.test.ts` is what keeps it true after this file has
 * been edited by somebody who has not read D8.
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  CompatibilityApplicability,
  CompatibilityRelationKind,
  CompatibilitySubject,
  CompatibilityTarget,
  CompatibilityVerificationState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { genericCompatibilityRelations } from '../schema/compatibility.js';

export type CompatibilityRelationRow = typeof genericCompatibilityRelations.$inferSelect;
export type InsertCompatibilityRelation = typeof genericCompatibilityRelations.$inferInsert;

/** How a caller narrows either direction of the lookup. */
export interface CompatibilityLookupFilter {
  readonly kinds?: readonly CompatibilityRelationKind[];
  readonly verifications?: readonly CompatibilityVerificationState[];
  readonly applicabilities?: readonly CompatibilityApplicability[];
  /**
   * An ISO 3166-1 alpha-2 market. A relation with `markets = '{}'` is WORLDWIDE
   * and matches every market — the `commerce_relationships.territories` posture,
   * so an unscoped claim is the broad one and filtering never hides it.
   */
  readonly market?: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit < 1) return 1;
  return limit > MAX_LIMIT ? MAX_LIMIT : limit;
}

/**
 * The shared narrowing, so the forward and reverse reads cannot drift.
 *
 * `valid_to is null` is not optional and is not a filter a caller may lift: a
 * closed relation is history, and this repository has no read that returns one
 * to a shopper. An operator's trace reads the row by id.
 */
function openRelationFilter(filter: CompatibilityLookupFilter) {
  const clauses = [isNull(genericCompatibilityRelations.validTo)];
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    clauses.push(inArray(genericCompatibilityRelations.kind, [...filter.kinds]));
  }
  if (filter.verifications !== undefined && filter.verifications.length > 0) {
    clauses.push(inArray(genericCompatibilityRelations.verification, [...filter.verifications]));
  }
  if (filter.applicabilities !== undefined && filter.applicabilities.length > 0) {
    clauses.push(inArray(genericCompatibilityRelations.applicability, [...filter.applicabilities]));
  }
  if (filter.market !== undefined) {
    // `'{}'` is WORLDWIDE, so the empty case is an explicit OR rather than a
    // containment test that would silently exclude every unscoped claim.
    clauses.push(
      or(
        sql`cardinality(${genericCompatibilityRelations.markets}) = 0`,
        sql`${genericCompatibilityRelations.markets} @> array[${filter.market}]::text[]`,
      ),
    );
  }
  return and(...clauses);
}

/** The subject predicate. A `switch` over a union with no common id field. */
function subjectFilter(subject: CompatibilitySubject) {
  switch (subject.kind) {
    case 'canonical_product':
      return eq(genericCompatibilityRelations.subjectProductId, subject.productId);
    case 'canonical_variant':
      return eq(genericCompatibilityRelations.subjectVariantId, subject.variantId);
  }
}

/** The target predicate, one per partial index. */
function targetFilter(target: CompatibilityTarget) {
  switch (target.kind) {
    case 'canonical_family':
      return eq(genericCompatibilityRelations.targetFamilyId, target.familyId);
    case 'canonical_product':
      return eq(genericCompatibilityRelations.targetProductId, target.productId);
    case 'canonical_variant':
      return eq(genericCompatibilityRelations.targetVariantId, target.variantId);
    case 'typed':
      return and(
        eq(genericCompatibilityRelations.targetType, target.target.type),
        eq(genericCompatibilityRelations.targetKey, target.target.key),
      );
  }
}

/** "What does this product or variant fit?" — the forward read. */
export async function listRelationsForSubject(
  subject: CompatibilitySubject,
  filter: CompatibilityLookupFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityRelationRow[]> {
  return db
    .select()
    .from(genericCompatibilityRelations)
    .where(and(subjectFilter(subject), openRelationFilter(filter)))
    .orderBy(
      genericCompatibilityRelations.kind,
      desc(genericCompatibilityRelations.createdAt),
      genericCompatibilityRelations.id,
    )
    .limit(boundedLimit(filter.limit));
}

/**
 * "What fits this?" — the reverse read D8 names, and the reason four partial
 * indexes exist on the table.
 *
 * A variant-scoped question ALSO returns the relations pointing at that
 * variant's product, because "cases for the 256 GB black one" is the same
 * question as "cases for this phone" for every accessory whose fit does not
 * depend on the configuration. The caller supplies the product id it already
 * has rather than this function joining for it — a join here would make the
 * reverse read two statements on every call to serve a case the caller usually
 * knows the answer to.
 */
export async function listRelationsForTarget(
  target: CompatibilityTarget,
  filter: CompatibilityLookupFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityRelationRow[]> {
  return db
    .select()
    .from(genericCompatibilityRelations)
    .where(and(targetFilter(target), openRelationFilter(filter)))
    .orderBy(
      genericCompatibilityRelations.kind,
      desc(genericCompatibilityRelations.createdAt),
      genericCompatibilityRelations.id,
    )
    .limit(boundedLimit(filter.limit));
}

/** One relation by id, for an operator trace. Returns closed rows too. */
export async function findRelationById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityRelationRow | null> {
  const [row] = await db
    .select()
    .from(genericCompatibilityRelations)
    .where(eq(genericCompatibilityRelations.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Open a relation, converging on the one that is already open.
 *
 * `ON CONFLICT DO NOTHING` on the partial unique, then a read — never a
 * read-then-write. Two ingestion workers observing one feed page converge on one
 * row, and the empty `RETURNING` set IS the "already open" answer rather than a
 * condition to catch. The conflict target repeats the index's own predicate,
 * because Postgres refuses to infer a partial unique's arbiter without it — the
 * `carts` finding (#104), which 500s rather than misbehaving, but only at
 * runtime.
 *
 * A repeat writes NOTHING at all: no tuple version, no `updated_at`, no lock.
 * That matters because a repeat is ordinary here — a re-crawl, a transaction
 * retry, two pages of one feed naming the same pairing.
 */
export async function openCompatibilityRelation(
  values: InsertCompatibilityRelation,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompatibilityRelationRow> {
  const [inserted] = await db
    .insert(genericCompatibilityRelations)
    .values(values)
    .onConflictDoNothing({
      target: [genericCompatibilityRelations.kind, genericCompatibilityRelations.relationKey],
      where: isNull(genericCompatibilityRelations.validTo),
    })
    .returning();
  if (inserted !== undefined) return inserted;

  const [existing] = await db
    .select()
    .from(genericCompatibilityRelations)
    .where(
      and(
        eq(genericCompatibilityRelations.kind, values.kind),
        eq(genericCompatibilityRelations.relationKey, relationKeyOf(values)),
        isNull(genericCompatibilityRelations.validTo),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    throw new Error(
      'openCompatibilityRelation: the insert conflicted and the conflicting row could not be read. ' +
        'That is a real failure (a concurrent close, a lost connection), not a duplicate — it must ' +
        'not be swallowed as one.',
    );
  }
  return existing;
}

/**
 * `relation_key` rendered exactly as the GENERATED column does.
 *
 * A second spelling of a generated expression is a thing that can disagree, so
 * `renders relation_key exactly as the generated column does` in
 * `compatibility.realdb.test.ts` compares this function's output against the
 * value Postgres actually stored, for every target kind. Without that test this
 * would be the classic re-implementation-under-test.
 */
export function relationKeyOf(values: InsertCompatibilityRelation): string {
  return [
    values.subjectProductId ?? '',
    values.subjectVariantId ?? '',
    values.targetFamilyId ?? '',
    values.targetProductId ?? '',
    values.targetVariantId ?? '',
    values.targetType ?? '',
    values.targetKey ?? '',
  ].join('|');
}

/**
 * Close a relation — the only way one stops applying.
 *
 * There is deliberately no delete in this repository. A relation that was
 * published and is now wrong is evidence of what a shopper was told, and the
 * correction is a close plus a new row linked through `superseded_by_id`.
 */
export async function closeCompatibilityRelation(
  id: string,
  closedAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const closed = await db
    .update(genericCompatibilityRelations)
    .set({ validTo: closedAt })
    .where(and(eq(genericCompatibilityRelations.id, id), isNull(genericCompatibilityRelations.validTo)))
    .returning({ id: genericCompatibilityRelations.id });
  return closed.length === 1;
}
