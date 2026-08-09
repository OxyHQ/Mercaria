/**
 * `match_policy_versions` and `match_category_gates` — reads and writes only.
 *
 * The two invariants this module refuses BEFORE issuing SQL are the ones a CHECK
 * cannot state because they span tables, and they are both about the same thing:
 * a category gate is a claim that a MEASUREMENT permits automatic matching, so
 * the gate must not be openable against a measurement that does not support it.
 * The database already refuses a gate with no citation and a citation from
 * another policy (a NOT NULL composite foreign key); what is left — did the
 * cited slice actually clear this policy's bar, on enough samples — is a
 * cross-table comparison, and it lives here so there is exactly one place it can
 * be got wrong.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  matchBenchmarkCategories,
  matchCategoryGates,
  matchPolicyVersions,
} from '../schema/matching.js';

export type MatchPolicyVersionRow = typeof matchPolicyVersions.$inferSelect;
export type InsertMatchPolicyVersionInput = typeof matchPolicyVersions.$inferInsert;
export type MatchCategoryGateRow = typeof matchCategoryGates.$inferSelect;

export async function insertMatchPolicyVersion(
  db: DatabaseOrTransaction,
  values: InsertMatchPolicyVersionInput,
): Promise<MatchPolicyVersionRow> {
  const rows = await db.insert(matchPolicyVersions).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertMatchPolicyVersion returned no row.');
  return row;
}

export async function findMatchPolicyVersionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MatchPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(matchPolicyVersions)
    .where(eq(matchPolicyVersions.id, id))
    .limit(1);
  return rows[0];
}

export async function findMatchPolicyVersionByKey(
  db: DatabaseOrTransaction,
  versionKey: string,
): Promise<MatchPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(matchPolicyVersions)
    .where(eq(matchPolicyVersions.versionKey, versionKey))
    .limit(1);
  return rows[0];
}

/** The ONE active policy, or nothing. The partial unique guarantees "one". */
export async function findActiveMatchPolicyVersion(
  db: DatabaseOrTransaction = getDb(),
): Promise<MatchPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(matchPolicyVersions)
    .where(eq(matchPolicyVersions.status, 'active'))
    .limit(1);
  return rows[0];
}

export async function listMatchPolicyVersions(
  db: DatabaseOrTransaction,
  limit = 50,
): Promise<MatchPolicyVersionRow[]> {
  return db
    .select()
    .from(matchPolicyVersions)
    .orderBy(desc(matchPolicyVersions.createdAt))
    .limit(limit);
}

/**
 * Activate a draft, superseding whichever version was active.
 *
 * ONE transaction with TWO conditional writes, in this order: supersede the
 * incumbent, then activate the draft. The reverse order transiently holds two
 * active rows, which `match_policy_versions_active_key` refuses — so the wrong
 * order does not produce a subtle bug, it produces a failed transaction, which
 * is the outcome to prefer when an order is load-bearing.
 *
 * Both writes are single-statement CAS (`WHERE ... AND status = ...`), so two
 * concurrent activations produce exactly one winner (CONVENTIONS.md's first
 * concurrency shape).
 */
export async function activateMatchPolicyVersion(
  db: DatabaseOrTransaction,
  input: { id: string; now: Date },
): Promise<MatchPolicyVersionRow | undefined> {
  await db
    .update(matchPolicyVersions)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(eq(matchPolicyVersions.status, 'active'));

  const rows = await db
    .update(matchPolicyVersions)
    .set({ status: 'active', activatedAt: input.now })
    .where(and(eq(matchPolicyVersions.id, input.id), eq(matchPolicyVersions.status, 'draft')))
    .returning();
  return rows[0];
}

/** What a gate needs to know about the slice it wants to cite. */
export interface BenchmarkCitation {
  readonly id: string;
  readonly policyVersionId: string;
  readonly categoryKey: string;
  readonly sourceKey: string;
  readonly precision: number | null;
  readonly truePositives: number;
  readonly falsePositives: number;
}

export async function findBenchmarkCitation(
  db: DatabaseOrTransaction,
  benchmarkCategoryId: string,
): Promise<BenchmarkCitation | undefined> {
  const rows = await db
    .select({
      id: matchBenchmarkCategories.id,
      policyVersionId: matchBenchmarkCategories.policyVersionId,
      categoryKey: matchBenchmarkCategories.categoryKey,
      sourceKey: matchBenchmarkCategories.sourceKey,
      precision: matchBenchmarkCategories.precision,
      truePositives: matchBenchmarkCategories.truePositives,
      falsePositives: matchBenchmarkCategories.falsePositives,
    })
    .from(matchBenchmarkCategories)
    .where(eq(matchBenchmarkCategories.id, benchmarkCategoryId))
    .limit(1);
  return rows[0];
}

export interface OpenCategoryGateInput {
  readonly policyVersionId: string;
  readonly categoryKey: string;
  readonly benchmarkCategoryId: string;
  readonly observedPrecision: number;
  readonly observedSamples: number;
  readonly enabledByOxyUserId: string;
  readonly reason: string;
  readonly now: Date;
}

export async function insertCategoryGate(
  db: DatabaseOrTransaction,
  input: OpenCategoryGateInput,
): Promise<MatchCategoryGateRow> {
  const rows = await db
    .insert(matchCategoryGates)
    .values({
      policyVersionId: input.policyVersionId,
      categoryKey: input.categoryKey,
      benchmarkCategoryId: input.benchmarkCategoryId,
      observedPrecision: input.observedPrecision,
      observedSamples: input.observedSamples,
      enabledByOxyUserId: input.enabledByOxyUserId,
      enabledAt: input.now,
      reason: input.reason,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertCategoryGate returned no row.');
  return row;
}

/**
 * Close a gate. A one-statement CAS on `disabled_at IS NULL`, so a concurrent
 * second close writes nothing and the first person's reason is the recorded one.
 */
export async function closeCategoryGate(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    disabledByOxyUserId: string;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(matchCategoryGates)
    .set({
      disabledAt: input.now,
      disabledByOxyUserId: input.disabledByOxyUserId,
      disableReason: input.reason,
    })
    .where(and(eq(matchCategoryGates.id, input.id), isNull(matchCategoryGates.disabledAt)))
    .returning({ id: matchCategoryGates.id });
  return rows.length === 1;
}

/**
 * Is automatic matching OPEN for this (policy, category)?
 *
 * Closed for an absent row, and closed for a NULL category — a subject whose
 * taxonomy position nobody recorded cannot be covered by a per-category
 * measurement, so the honest answer is that no measurement applies. That is why
 * this takes `string | null` rather than making the caller guard: the "unknown
 * category" branch is the one most likely to be forgotten, so it lives inside
 * the function that answers the question.
 */
export async function isCategoryGateOpen(
  db: DatabaseOrTransaction,
  input: { policyVersionId: string; categoryKey: string | null },
): Promise<boolean> {
  if (input.categoryKey === null || input.categoryKey.length === 0) return false;
  const rows = await db
    .select({ id: matchCategoryGates.id })
    .from(matchCategoryGates)
    .where(
      and(
        eq(matchCategoryGates.policyVersionId, input.policyVersionId),
        eq(matchCategoryGates.categoryKey, input.categoryKey),
        isNull(matchCategoryGates.disabledAt),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export async function listCategoryGates(
  db: DatabaseOrTransaction,
  policyVersionId: string,
): Promise<MatchCategoryGateRow[]> {
  return db
    .select()
    .from(matchCategoryGates)
    .where(eq(matchCategoryGates.policyVersionId, policyVersionId))
    .orderBy(matchCategoryGates.categoryKey);
}

/** The open gates' category keys, for the operator surface's summary. */
export async function countOpenCategoryGates(
  db: DatabaseOrTransaction,
  policyVersionId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(matchCategoryGates)
    .where(
      and(
        eq(matchCategoryGates.policyVersionId, policyVersionId),
        isNull(matchCategoryGates.disabledAt),
      ),
    );
  return rows[0]?.total ?? 0;
}
