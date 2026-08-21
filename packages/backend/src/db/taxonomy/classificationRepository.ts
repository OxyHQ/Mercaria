/**
 * Secondary category classifications — the only writer, and the composed read
 * (#367 Workstream 1, ADR 0007 D2/D3/D4).
 *
 * ## What this module does NOT do
 *
 * It never writes `listings.category_id` or `canonical_products.category_id`.
 * Those are the PRIMARY category, they already have owners
 * (`catalog-write.service.ts` for a listing, `canonical-product.service.ts` for
 * a canonical product), and adding a second writer here is how one subject ends
 * up with two places that decide its filing.
 *
 * So there is deliberately no `setPrimaryCategory` in this file. What it reads
 * from those columns, it reads.
 *
 * ## The invariants live in the DATABASE, and these functions do not restate them
 *
 * "One filing per (subject, category)", "not the primary, nor its ancestor or
 * descendant", "a secondary requires a primary", "the category is selectable"
 * and "the lifecycle is assignable" are a unique index, three triggers and a
 * CHECK set (`drizzle/0134_red_silver_fox.sql`). This module does not re-derive
 * any of them before writing.
 *
 * That is a decision, not an omission. A pre-check here would be a SECOND
 * authority over each rule that could disagree with the first, and — because
 * every one of them is a fact about a row this statement is not writing — it
 * would also be a check-then-act race on a shared server: two concurrent
 * requests both read "fine" and one of them then writes the state the rule
 * forbids. The database refuses under a lock; a service cannot. What this
 * module does instead is TRANSLATE the refusal, so a caller gets a reason
 * rather than a 500.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ClassificationSubjectKind,
  PrimaryClassification,
  ProductClassification,
  SecondaryClassification,
  SecondaryClassificationReason,
} from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { categories, listings } from '../schema/catalog.js';
import { canonicalProducts } from '../schema/canonicalCatalog.js';
import {
  canonicalProductSecondaryCategories,
  listingSecondaryCategories,
} from '../schema/taxonomyClassification.js';

/** What a caller supplies to record one secondary classification. */
export interface NewSecondaryClassification {
  readonly subjectKind: ClassificationSubjectKind;
  readonly subjectId: string;
  readonly categoryId: string;
  readonly reason: SecondaryClassificationReason;
  readonly justification: string;
  readonly schemeRef?: string;
  readonly justifiedBy: string;
}

/**
 * The two tables, keyed by subject, with the column each names its subject by.
 *
 * A lookup rather than an `if` in six places: every function below needs the
 * same pairing, and six independent branches are six chances to write the
 * listing table's name beside the canonical product's id column — a mistake
 * that type-checks, because both ids are `text`.
 */
const SUBJECTS = {
  listing: {
    table: listingSecondaryCategories,
    subjectColumn: listingSecondaryCategories.listingId,
    parentTable: listings,
    parentId: listings.id,
    parentCategoryId: listings.categoryId,
  },
  canonical_product: {
    table: canonicalProductSecondaryCategories,
    subjectColumn: canonicalProductSecondaryCategories.canonicalProductId,
    parentTable: canonicalProducts,
    parentId: canonicalProducts.id,
    parentCategoryId: canonicalProducts.categoryId,
  },
} as const;

/** A stored row plus its category's key, projected onto the shared DTO. */
function toSecondaryClassification(
  subjectKind: ClassificationSubjectKind,
  subjectId: string,
  row: {
    readonly id: string;
    readonly categoryId: string;
    readonly categoryKey: string;
    readonly reason: string;
    readonly justification: string;
    readonly schemeRef: string | null;
    readonly justifiedBy: string;
    readonly justifiedAt: Date;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
): SecondaryClassification {
  return {
    id: row.id,
    subjectKind,
    subjectId,
    categoryId: row.categoryId,
    categoryKey: row.categoryKey,
    reason: row.reason as SecondaryClassificationReason,
    justification: row.justification,
    // Spread rather than `schemeRef: row.schemeRef ?? undefined`, so the key is
    // ABSENT rather than present-and-undefined. `exactOptionalPropertyTypes` is
    // off here, so the two are interchangeable to `tsc` and are NOT
    // interchangeable to `JSON.stringify` — one emits no key, the other emits
    // none either but leaves the property enumerable for anything that walks it,
    // which the DTO forbidden-field gates do.
    ...(row.schemeRef === null ? {} : { schemeRef: row.schemeRef }),
    justifiedBy: row.justifiedBy,
    justifiedAt: row.justifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Record one secondary classification.
 *
 * No `ON CONFLICT`. A repeat on (subject, category) is REFUSED by
 * `*_secondary_categories_key` and surfaces as a conflict, because the second
 * request carries a different justification and a different author — silently
 * keeping the first would discard a decision somebody made and silently
 * overwriting it would discard the one already on the record. A correction is
 * an explicit update.
 */
export async function insertSecondaryClassification(
  input: NewSecondaryClassification,
): Promise<SecondaryClassification> {
  const db = getDb();

  const shared = {
    categoryId: input.categoryId,
    reason: input.reason,
    justification: input.justification,
    schemeRef: input.schemeRef ?? null,
    justifiedBy: input.justifiedBy,
    justifiedAt: new Date(),
  };

  /**
   * Two concrete inserts rather than one over `SUBJECTS[kind].table`.
   *
   * The lookup is right for reads, where both tables project the same columns.
   * It is wrong for a WRITE: the two tables have different subject columns, so
   * the union's `values` type collapses and the only way to satisfy it is a
   * cast — which would also accept `{ listingId }` against the canonical table,
   * since both ids are `text`. The branch costs four lines and makes that
   * mistake fail to compile.
   */
  const [inserted] =
    input.subjectKind === 'listing'
      ? await db
          .insert(listingSecondaryCategories)
          .values({ ...shared, listingId: input.subjectId })
          .returning()
      : await db
          .insert(canonicalProductSecondaryCategories)
          .values({ ...shared, canonicalProductId: input.subjectId })
          .returning();

  if (!inserted) {
    // Unreachable without an `ON CONFLICT`, and stated rather than assumed: an
    // empty `RETURNING` from a plain insert would mean a rule changed under us.
    throw new Error('insertSecondaryClassification wrote no row');
  }

  const [category] = await db
    .select({ key: categories.key })
    .from(categories)
    .where(eq(categories.id, input.categoryId))
    .limit(1);

  return toSecondaryClassification(input.subjectKind, input.subjectId, {
    ...inserted,
    categoryKey: category?.key ?? '',
  });
}

/** Withdraw one secondary classification. Returns whether a row was removed. */
export async function deleteSecondaryClassification(
  subjectKind: ClassificationSubjectKind,
  subjectId: string,
  categoryId: string,
): Promise<boolean> {
  const db = getDb();
  const subject = SUBJECTS[subjectKind];

  const removed = await db
    .delete(subject.table)
    .where(and(eq(subject.subjectColumn, subjectId), eq(subject.table.categoryId, categoryId)))
    .returning({ id: subject.table.id });

  return removed.length > 0;
}

/**
 * Everything filed about one subject — the primary read off the subject's own
 * column, and every secondary beneath it.
 *
 * TWO statements, not one per secondary: the subject row (joined to its primary
 * category) and then the secondaries (joined to theirs). An N+1 over categories
 * is the shape this would naturally take and it is unnecessary — the join is
 * one hop.
 *
 * Returns `null` when the subject does not exist, which a caller renders as a
 * 404. That is different from `unclassified`, which is a subject that exists and
 * has no primary.
 */
export async function findProductClassification(
  subjectKind: ClassificationSubjectKind,
  subjectId: string,
): Promise<ProductClassification | null> {
  const db = getDb();
  const subject = SUBJECTS[subjectKind];

  const [row] = await db
    .select({
      id: subject.parentId,
      categoryId: subject.parentCategoryId,
      categoryKey: categories.key,
      ancestorSlugs: categories.ancestorSlugs,
    })
    .from(subject.parentTable)
    .leftJoin(categories, eq(categories.id, subject.parentCategoryId))
    .where(eq(subject.parentId, subjectId))
    .limit(1);

  if (!row) {
    return null;
  }

  // A LEFT join, so a subject with no primary yields a row whose category
  // columns are NULL. `categoryId` is the one to test — `categoryKey` would
  // also be NULL for a dangling reference, which the foreign key makes
  // impossible but which would read identically here.
  if (row.categoryId === null) {
    return { state: 'unclassified', subjectKind, subjectId };
  }

  const primary: PrimaryClassification = {
    categoryId: row.categoryId,
    categoryKey: row.categoryKey ?? '',
    ancestorSlugs: row.ancestorSlugs ?? [],
  };

  const secondaryRows = await db
    .select({
      id: subject.table.id,
      categoryId: subject.table.categoryId,
      categoryKey: categories.key,
      reason: subject.table.reason,
      justification: subject.table.justification,
      schemeRef: subject.table.schemeRef,
      justifiedBy: subject.table.justifiedBy,
      justifiedAt: subject.table.justifiedAt,
      createdAt: subject.table.createdAt,
      updatedAt: subject.table.updatedAt,
    })
    .from(subject.table)
    .innerJoin(categories, eq(categories.id, subject.table.categoryId))
    .where(eq(subject.subjectColumn, subjectId))
    .orderBy(desc(subject.table.createdAt), subject.table.id);

  return {
    state: 'classified',
    subjectKind,
    subjectId,
    primary,
    secondary: secondaryRows.map((secondary) =>
      toSecondaryClassification(subjectKind, subjectId, secondary as never),
    ),
  };
}

/**
 * The reverse read: what is filed under this category as a SECONDARY.
 *
 * The reader `*_secondary_categories_category_idx` exists for — a mechanism can
 * be green and inert, and an index with no reader is exactly that. An operator
 * asks this before deprecating or merging a node, which is why it counts both
 * subject kinds rather than making the caller ask twice and add up.
 */
export async function countSecondaryClassificationsByCategory(
  categoryId: string,
): Promise<{ readonly listings: number; readonly canonicalProducts: number }> {
  const db = getDb();

  const [listingCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(listingSecondaryCategories)
    .where(eq(listingSecondaryCategories.categoryId, categoryId));

  const [productCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(canonicalProductSecondaryCategories)
    .where(eq(canonicalProductSecondaryCategories.categoryId, categoryId));

  return {
    listings: listingCount?.total ?? 0,
    canonicalProducts: productCount?.total ?? 0,
  };
}

/**
 * Every secondary classification for a set of subjects, batched.
 *
 * `POST /users/by-ids`'s reasoning applied locally: a projection that renders N
 * subjects must not issue N statements. Nothing consumes this yet — it exists
 * because the composed read above is per subject, and the first list view that
 * needs classifications would otherwise write the loop.
 */
export async function findSecondaryClassificationsForSubjects(
  subjectKind: ClassificationSubjectKind,
  subjectIds: readonly string[],
): Promise<Map<string, SecondaryClassification[]>> {
  const grouped = new Map<string, SecondaryClassification[]>();
  if (subjectIds.length === 0) {
    return grouped;
  }

  const db = getDb();
  const subject = SUBJECTS[subjectKind];

  const rows = await db
    .select({
      subjectId: subject.subjectColumn,
      id: subject.table.id,
      categoryId: subject.table.categoryId,
      categoryKey: categories.key,
      reason: subject.table.reason,
      justification: subject.table.justification,
      schemeRef: subject.table.schemeRef,
      justifiedBy: subject.table.justifiedBy,
      justifiedAt: subject.table.justifiedAt,
      createdAt: subject.table.createdAt,
      updatedAt: subject.table.updatedAt,
    })
    .from(subject.table)
    .innerJoin(categories, eq(categories.id, subject.table.categoryId))
    .where(inArray(subject.subjectColumn, [...subjectIds]));

  for (const row of rows) {
    const list = grouped.get(row.subjectId) ?? [];
    list.push(toSecondaryClassification(subjectKind, row.subjectId, row as never));
    grouped.set(row.subjectId, list);
  }

  return grouped;
}
