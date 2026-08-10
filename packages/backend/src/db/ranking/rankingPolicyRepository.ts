/**
 * `ranking_policy_versions` reads and writes (#74).
 *
 * Every transition is a CAS on the row's current status, and the two partial
 * unique indexes (`one_active_per_key`, `one_canary_per_key`) are what make the
 * arms singular — not a check this module performs. Two operators activating two
 * versions at once therefore converge on one winner and one refusal, rather than
 * on two rows both claiming to be active.
 *
 * There is deliberately no DELETE. A version that served traffic is what an
 * impression's `ranking_policy_version` points at, and removing it would leave
 * every logged impression naming a policy nobody can read.
 */

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { rankingPolicyVersions } from '../schema/ranking.js';

export type RankingPolicyVersionRow = InferSelectModel<typeof rankingPolicyVersions>;

/** The statuses that serve traffic. A version outside them routes nothing. */
const SERVING_STATUSES = ['active', 'canary'] as const;

/** A new draft, exactly as an operator submitted it. */
export interface NewRankingPolicyVersion {
  readonly policyKey: string;
  readonly version: string;
  readonly description: string;
  readonly weightItemPrice: number;
  readonly weightDeliveryCost: number;
  readonly weightTaxInclusion: number;
  readonly weightDeliverySpeed: number;
  readonly weightCondition: number;
  readonly weightMerchantRating: number;
  readonly weightReturnPolicy: number;
  readonly weightAvailabilityConfidence: number;
  readonly weightObservationFreshness: number;
  readonly weightVerifiedRelationship: number;
  readonly weightPickupProximity: number;
  readonly minReviewCount: number;
  readonly dominanceWindow: number;
  readonly dominanceShare: number;
  readonly objectiveMetricKeys: readonly string[];
  readonly guardrailMetricKeys: readonly string[];
  readonly createdByOxyUserId: string;
}

/** Insert one draft. Every economic column is editable only while it is one. */
export async function insertRankingPolicyVersion(
  input: NewRankingPolicyVersion,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow> {
  const [row] = await db
    .insert(rankingPolicyVersions)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      description: input.description,
      weightItemPrice: input.weightItemPrice,
      weightDeliveryCost: input.weightDeliveryCost,
      weightTaxInclusion: input.weightTaxInclusion,
      weightDeliverySpeed: input.weightDeliverySpeed,
      weightCondition: input.weightCondition,
      weightMerchantRating: input.weightMerchantRating,
      weightReturnPolicy: input.weightReturnPolicy,
      weightAvailabilityConfidence: input.weightAvailabilityConfidence,
      weightObservationFreshness: input.weightObservationFreshness,
      weightVerifiedRelationship: input.weightVerifiedRelationship,
      weightPickupProximity: input.weightPickupProximity,
      minReviewCount: input.minReviewCount,
      dominanceWindow: input.dominanceWindow,
      dominanceShare: input.dominanceShare,
      objectiveMetricKeys: [...input.objectiveMetricKeys],
      guardrailMetricKeys: [...input.guardrailMetricKeys],
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (row === undefined) {
    throw new Error('Failed to insert ranking policy version');
  }
  return row;
}

/** The versions currently serving traffic — at most one of each arm. */
export async function findServingRankingPolicies(
  policyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow[]> {
  return db
    .select()
    .from(rankingPolicyVersions)
    .where(
      and(
        eq(rankingPolicyVersions.policyKey, policyKey),
        inArray(rankingPolicyVersions.status, [...SERVING_STATUSES]),
      ),
    );
}

/** One version by its `(policy_key, version)` public name. */
export async function findRankingPolicyVersion(
  policyKey: string,
  version: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow | null> {
  const [row] = await db
    .select()
    .from(rankingPolicyVersions)
    .where(
      and(eq(rankingPolicyVersions.policyKey, policyKey), eq(rankingPolicyVersions.version, version)),
    )
    .limit(1);
  return row ?? null;
}

/** One key's versions, newest first — the operator surface's list. */
export async function listRankingPolicyVersions(
  policyKey: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow[]> {
  return db
    .select()
    .from(rankingPolicyVersions)
    .where(eq(rankingPolicyVersions.policyKey, policyKey))
    .orderBy(desc(rankingPolicyVersions.createdAt))
    .limit(limit);
}

/**
 * Make one version the ACTIVE arm, superseding whichever held it.
 *
 * One transaction, and the supersede runs FIRST: the partial unique index
 * refuses two active rows, so the order is not a preference — reversing it makes
 * every activation fail. A rollback is this same call naming an earlier version,
 * which is what makes acceptance 7's "rolled back without re-ingesting offers"
 * one statement rather than a procedure.
 */
export async function activateRankingPolicyVersion(
  input: { readonly id: string; readonly policyKey: string; readonly actorOxyUserId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow | null> {
  return db.transaction(async (tx) => {
    await tx
      .update(rankingPolicyVersions)
      .set({ status: 'superseded', supersededAt: new Date() })
      .where(
        and(
          eq(rankingPolicyVersions.policyKey, input.policyKey),
          eq(rankingPolicyVersions.status, 'active'),
          ne(rankingPolicyVersions.id, input.id),
        ),
      );

    const [row] = await tx
      .update(rankingPolicyVersions)
      .set({
        status: 'active',
        canaryShareBps: 0,
        approvedByOxyUserId: input.actorOxyUserId,
        activatedAt: sql`coalesce(${rankingPolicyVersions.activatedAt}, now())`,
      })
      .where(
        and(
          eq(rankingPolicyVersions.id, input.id),
          inArray(rankingPolicyVersions.status, ['draft', 'canary', 'superseded']),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Start or ramp a canary.
 *
 * One call for both, because they are the same write: the CHECK ties a non-zero
 * share to the `canary` status, and the immutability trigger names
 * `canary_share_bps` as the one column a serving version may still move. A ramp
 * is monotone over subjects (`resolveRankingArm`), so raising the share never
 * moves a subject back onto the active arm mid-flight.
 */
export async function setRankingPolicyCanary(
  input: { readonly id: string; readonly shareBps: number; readonly actorOxyUserId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow | null> {
  const [row] = await db
    .update(rankingPolicyVersions)
    .set({
      status: 'canary',
      canaryShareBps: input.shareBps,
      approvedByOxyUserId: input.actorOxyUserId,
      activatedAt: sql`coalesce(${rankingPolicyVersions.activatedAt}, now())`,
    })
    .where(
      and(
        eq(rankingPolicyVersions.id, input.id),
        inArray(rankingPolicyVersions.status, ['draft', 'canary']),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Stop a canary without promoting it.
 *
 * It becomes `superseded`, never `draft`: a version that has served traffic is
 * what impressions point at, and `draft` is the one status the immutability
 * trigger lets an operator edit — so returning it there would let somebody
 * rewrite the weights an already-logged impression names.
 */
export async function stopRankingPolicyCanary(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow | null> {
  const [row] = await db
    .update(rankingPolicyVersions)
    .set({ status: 'superseded', canaryShareBps: 0, supersededAt: new Date() })
    .where(and(eq(rankingPolicyVersions.id, id), eq(rankingPolicyVersions.status, 'canary')))
    .returning();
  return row ?? null;
}

/** Retire a version from the operator's list. Terminal, and never a delete. */
export async function archiveRankingPolicyVersion(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicyVersionRow | null> {
  const [row] = await db
    .update(rankingPolicyVersions)
    .set({ status: 'archived', canaryShareBps: 0, archivedAt: new Date() })
    .where(
      and(
        eq(rankingPolicyVersions.id, id),
        inArray(rankingPolicyVersions.status, ['draft', 'superseded']),
      ),
    )
    .returning();
  return row ?? null;
}
