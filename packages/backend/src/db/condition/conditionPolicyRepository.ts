/**
 * `condition_category_policies` — the conditions a category refuses (#90 policy
 * rule 5).
 *
 * ## The read is by SLUG PATH, not by category id
 *
 * A restriction on `electronics` has to reach `electronics/phones`, and
 * `listings.category_slugs` already holds the leaf's slug plus every ancestor's
 * — denormalized for exactly this class of question. So the lookup joins the
 * policy's category to that array rather than walking `parent_id` recursively:
 * one indexed comparison instead of a recursive CTE on every listing write, and
 * it reads the same materialized path every browse query does, so a restriction
 * cannot apply to a category the catalogue thinks is elsewhere.
 *
 * `include_descendants = false` narrows a row back to the exact category, which
 * is why the predicate tests both.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ConditionRestrictionReason, ItemConditionKey } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import { conditionCategoryPolicies } from '../schema/condition.js';

export type ConditionCategoryPolicyRecord = InferSelectModel<typeof conditionCategoryPolicies>;

/** One restriction, as an operator states it. */
export interface NewConditionCategoryPolicy {
  categoryId: string;
  conditionKey: ItemConditionKey;
  restriction: ConditionRestrictionReason;
  includeDescendants: boolean;
  reason: string;
  createdByOxyUserId: string;
}

/**
 * Every restriction that applies to a listing in this category.
 *
 * `categorySlugs` is the listing's own denormalized ancestor path, so a policy
 * matches when its category is the listing's exact one, or is an ancestor whose
 * row says it reaches descendants.
 *
 * An empty `categorySlugs` (an uncategorized listing) matches nothing, which is
 * correct: a restriction is a statement about a category, and a listing in none
 * is not in the restricted one.
 */
export async function findApplicablePolicies(
  tx: DatabaseOrTransaction,
  categoryId: string | null,
  categorySlugs: readonly string[],
): Promise<ConditionCategoryPolicyRecord[]> {
  if (!categoryId && categorySlugs.length === 0) return [];

  const exact = categoryId ? eq(conditionCategoryPolicies.categoryId, categoryId) : undefined;
  const inherited =
    categorySlugs.length > 0
      ? and(
          eq(conditionCategoryPolicies.includeDescendants, true),
          inArray(categories.slug, [...categorySlugs]),
        )
      : undefined;

  const predicate = exact && inherited ? or(exact, inherited) : (exact ?? inherited);
  if (!predicate) return [];

  const rows = await tx
    .select({ policy: conditionCategoryPolicies })
    .from(conditionCategoryPolicies)
    .innerJoin(categories, eq(categories.id, conditionCategoryPolicies.categoryId))
    .where(predicate);

  return rows.map((row) => row.policy);
}

/** Every restriction on one category, for the operator surface. */
export async function findPoliciesByCategory(
  categoryId: string,
): Promise<ConditionCategoryPolicyRecord[]> {
  return getDb()
    .select()
    .from(conditionCategoryPolicies)
    .where(eq(conditionCategoryPolicies.categoryId, categoryId));
}

/**
 * Record or replace one restriction.
 *
 * `ON CONFLICT DO UPDATE` on `(category_id, condition_key)`: an operator
 * restating a restriction with a better reason is correcting it, not creating a
 * second one, and the unique index means there is exactly one row to correct.
 * The author is overwritten too — the current statement is whoever made it.
 */
export async function upsertConditionCategoryPolicy(
  policy: NewConditionCategoryPolicy,
): Promise<ConditionCategoryPolicyRecord> {
  const [row] = await getDb()
    .insert(conditionCategoryPolicies)
    .values(policy)
    .onConflictDoUpdate({
      target: [conditionCategoryPolicies.categoryId, conditionCategoryPolicies.conditionKey],
      set: {
        restriction: sql`excluded.restriction`,
        includeDescendants: sql`excluded.include_descendants`,
        reason: sql`excluded.reason`,
        createdByOxyUserId: sql`excluded.created_by_oxy_user_id`,
      },
    })
    .returning();

  if (!row) {
    throw new Error('Condition category policy upsert returned no row');
  }
  return row;
}

/** Lift one restriction. */
export async function deleteConditionCategoryPolicy(
  categoryId: string,
  conditionKey: ItemConditionKey,
): Promise<boolean> {
  const deleted = await getDb()
    .delete(conditionCategoryPolicies)
    .where(
      and(
        eq(conditionCategoryPolicies.categoryId, categoryId),
        eq(conditionCategoryPolicies.conditionKey, conditionKey),
      ),
    )
    .returning({ id: conditionCategoryPolicies.id });

  return deleted.length > 0;
}
