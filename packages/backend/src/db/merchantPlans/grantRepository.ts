/**
 * `entitlement_grants` — capabilities given outside a plan (#89 domain model
 * item 5).
 *
 * A grant only ever ADDS. There is no update that could turn one negative and no
 * column that could express one, because the capabilities a free merchant relies
 * on are ungateable by construction — so the only thing a removing grant could
 * take away is something a merchant is paying for, and the honest way to do that
 * is to change the plan.
 *
 * Revocation is the one mutation, and it is a compare-and-swap on
 * `revoked_at IS NULL`: two operators revoking the same grant produce exactly one
 * revocation, with one attributable actor and one reason.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  EntitlementGrantReason,
  EntitlementLimitKind,
  MerchantEntitlementCapability,
} from '@mercaria/shared-types';
import { entitlementGrants } from '../schema/merchantPlans.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `entitlement_grants`. */
export type EntitlementGrantRow = typeof entitlementGrants.$inferSelect;

/** A grant, as the operator surface supplies it. */
export interface NewEntitlementGrant {
  storeId: string;
  /** The caller's stable identifier — a retry under the same key converges. */
  grantKey: string;
  capabilityKey: MerchantEntitlementCapability;
  limitKind: EntitlementLimitKind;
  limitValue?: number | null;
  reason: EntitlementGrantReason;
  note: string;
  grantedByOxyUserId: string;
  startsAt: Date;
  expiresAt?: Date;
}

/**
 * Record a grant, converging on a replay.
 *
 * `ON CONFLICT DO NOTHING` against `(store_id, grant_key)`: a retried operator
 * request is the SAME decision and must not stack a second grant on top of the
 * first. The empty vs one-row `RETURNING` set is the "already granted" answer.
 */
export async function insertEntitlementGrant(
  db: DatabaseOrTransaction,
  input: NewEntitlementGrant,
): Promise<{ created: boolean; row: EntitlementGrantRow }> {
  const [inserted] = await db
    .insert(entitlementGrants)
    .values({
      storeId: input.storeId,
      grantKey: input.grantKey,
      capabilityKey: input.capabilityKey,
      limitKind: input.limitKind,
      ...(input.limitValue === undefined ? {} : { limitValue: input.limitValue }),
      reason: input.reason,
      note: input.note,
      grantedByOxyUserId: input.grantedByOxyUserId,
      startsAt: input.startsAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    })
    .onConflictDoNothing({ target: [entitlementGrants.storeId, entitlementGrants.grantKey] })
    .returning();
  if (inserted) return { created: true, row: inserted };

  const existing = await findEntitlementGrantByKey(db, {
    storeId: input.storeId,
    grantKey: input.grantKey,
  });
  if (!existing) {
    throw new Error(
      `Grant ${input.grantKey} for store ${input.storeId} conflicted but cannot be read back.`,
    );
  }
  return { created: false, row: existing };
}

/** One grant by its caller-supplied key, or `undefined`. */
export async function findEntitlementGrantByKey(
  db: DatabaseOrTransaction,
  input: { storeId: string; grantKey: string },
): Promise<EntitlementGrantRow | undefined> {
  const [row] = await db
    .select()
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.storeId, input.storeId),
        eq(entitlementGrants.grantKey, input.grantKey),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Every grant of one store that is LIVE at `at` — unrevoked, started, unexpired.
 *
 * The window is evaluated in SQL rather than in the resolver so a page of grants
 * is not fetched to be thrown away, and because `now()` cannot appear in an
 * index predicate: there is no partial unique keeping one live grant per
 * capability, and there does not need to be — several are legitimate (a trial
 * then a partnership) and the resolver takes the most generous.
 */
export async function listLiveEntitlementGrants(
  db: DatabaseOrTransaction,
  input: { storeId: string; at: Date },
): Promise<EntitlementGrantRow[]> {
  return await db
    .select()
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.storeId, input.storeId),
        isNull(entitlementGrants.revokedAt),
        sql`${entitlementGrants.startsAt} <= ${input.at.toISOString()}::timestamptz`,
        sql`${entitlementGrants.expiresAt} is null
            or ${entitlementGrants.expiresAt} > ${input.at.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(entitlementGrants.capabilityKey));
}

/** Every grant of one store, live or not — the operator trace. */
export async function listEntitlementGrants(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<EntitlementGrantRow[]> {
  return await db
    .select()
    .from(entitlementGrants)
    .where(eq(entitlementGrants.storeId, storeId))
    .orderBy(asc(entitlementGrants.capabilityKey), asc(entitlementGrants.createdAt));
}

/**
 * Revoke one grant.
 *
 * @returns The revoked row, or `undefined` when the CAS matched nothing — it was
 *   already revoked, which the caller reports rather than retries.
 */
export async function revokeEntitlementGrant(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; revocationReason: string; at?: Date },
): Promise<EntitlementGrantRow | undefined> {
  const [row] = await db
    .update(entitlementGrants)
    .set({
      revokedAt: input.at ?? new Date(),
      revokedByOxyUserId: input.revokedByOxyUserId,
      revocationReason: input.revocationReason,
    })
    .where(and(eq(entitlementGrants.id, input.id), isNull(entitlementGrants.revokedAt)))
    .returning();
  return row;
}
