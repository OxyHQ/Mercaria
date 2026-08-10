/**
 * Reads and writes on `guest_order_claims` (#109).
 *
 * Every write here is either an INSERT or a state transition guarded on the
 * state it is leaving. There is deliberately no general `updateClaim`: a claim
 * is a commercial-ownership record, and a function that could set any column
 * would be the one somebody eventually uses to move a group between accounts
 * without the audited correction path — which is exactly what ADR 0003 D14's
 * "never a stronger claim" forbids.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  GuestClaimConflictReason,
  GuestClaimRevocationReason,
} from '@mercaria/shared-types';
import { guestOrderClaims } from '../schema/guestClaims.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_order_claims` row as the backend reads it. */
export type GuestOrderClaimRow = typeof guestOrderClaims.$inferSelect;

/** What a COMPLETED claim insert writes. */
export interface InsertCompletedClaimInput {
  checkoutGroupId: string;
  guestCheckoutId: string;
  claimedByOxyUserId: string;
  /** The grant row that proved possession. An audit handle, never a credential. */
  sourceGrantId: string;
  orderCount: number;
  now: Date;
}

/**
 * Record a completed claim, or lose the race.
 *
 * `ON CONFLICT DO NOTHING` on `guest_order_claims_active_group_key` returns an
 * EMPTY set when another transaction already holds the group — and that empty
 * set IS the conflict answer, in the `moderation_events` shape. Reading first
 * and then inserting would leave a window between the two, which is precisely
 * where a second claimant lands.
 *
 * The conflict target names the partial index's own predicate, because Postgres
 * cannot infer a partial arbiter without it (the `carts` owner-uniques lesson,
 * #104).
 */
export async function insertCompletedClaim(
  db: DatabaseOrTransaction,
  input: InsertCompletedClaimInput,
): Promise<GuestOrderClaimRow | null> {
  const rows = await db
    .insert(guestOrderClaims)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      guestCheckoutId: input.guestCheckoutId,
      claimedByOxyUserId: input.claimedByOxyUserId,
      sourceGrantId: input.sourceGrantId,
      state: 'completed',
      orderCount: input.orderCount,
      completedAt: input.now,
    })
    // `where` REPEATS the partial index's own predicate. Postgres cannot infer
    // a partial arbiter without it and answers `there is no unique or exclusion
    // constraint matching the ON CONFLICT specification` — a runtime failure
    // `tsc` cannot see, which every real-database test in #104 hit before the
    // predicate was added.
    .onConflictDoNothing({
      target: guestOrderClaims.checkoutGroupId,
      where: eq(guestOrderClaims.state, 'completed'),
    })
    .returning();
  return rows[0] ?? null;
}

/**
 * Record a contest — a fully-proven attempt on a group somebody else holds.
 *
 * A plain insert with no conflict target: `conflicted` rows do not participate
 * in the active-group index, so two rivals racing produce two records, which is
 * the honest account of what happened. This is the ONLY write in the domain
 * that a caller who will be refused still performs, and it is what #109
 * claim-model rule 8 asks for.
 */
export async function insertConflictedClaim(
  db: DatabaseOrTransaction,
  input: InsertCompletedClaimInput & { conflictReason: GuestClaimConflictReason },
): Promise<GuestOrderClaimRow> {
  const [row] = await db
    .insert(guestOrderClaims)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      guestCheckoutId: input.guestCheckoutId,
      claimedByOxyUserId: input.claimedByOxyUserId,
      sourceGrantId: input.sourceGrantId,
      state: 'conflicted',
      orderCount: input.orderCount,
      conflictReason: input.conflictReason,
    })
    .returning();
  return row;
}

/** The live claim on a group, if any. `null` means unclaimed. */
export async function findActiveClaimForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<GuestOrderClaimRow | null> {
  const [row] = await db
    .select()
    .from(guestOrderClaims)
    .where(
      and(
        eq(guestOrderClaims.checkoutGroupId, checkoutGroupId),
        eq(guestOrderClaims.state, 'completed'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One claim by id, whatever its state. */
export async function findClaimById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<GuestOrderClaimRow | null> {
  const [row] = await db
    .select()
    .from(guestOrderClaims)
    .where(eq(guestOrderClaims.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The live claim on a group, LOCKED.
 *
 * Used by the revocation executor so an approval cannot race a concurrent
 * claim of the same group. The claim transaction itself does not need this —
 * it serializes on `guest_checkouts` before any claim row exists to lock.
 */
export async function findActiveClaimForGroupForUpdate(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<GuestOrderClaimRow | null> {
  const [row] = await db
    .select()
    .from(guestOrderClaims)
    .where(
      and(
        eq(guestOrderClaims.checkoutGroupId, checkoutGroupId),
        eq(guestOrderClaims.state, 'completed'),
      ),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Move a completed claim to `revoked` — the compensating operation's write.
 *
 * Guarded on `state = 'completed'`, so an approval executed twice moves nothing
 * the second time and the caller reads the empty result as convergence. The
 * row keeps `completed_at`, its source grant and its order count: a correction
 * records what it undid rather than erasing it (#109 revocation rule 4).
 */
export async function markClaimRevoked(
  db: DatabaseOrTransaction,
  input: {
    claimId: string;
    revokedByOxyUserId: string;
    reason: GuestClaimRevocationReason;
    now: Date;
  },
): Promise<GuestOrderClaimRow | null> {
  const rows = await db
    .update(guestOrderClaims)
    .set({
      state: 'revoked',
      revokedAt: input.now,
      revokedByOxyUserId: input.revokedByOxyUserId,
      revocationReason: input.reason,
    })
    .where(
      and(eq(guestOrderClaims.id, input.claimId), eq(guestOrderClaims.state, 'completed')),
    )
    .returning();
  return rows[0] ?? null;
}

/** Every claim recorded against one checkout group, newest first — the trace. */
export async function listClaimsForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  limit: number,
): Promise<GuestOrderClaimRow[]> {
  return await db
    .select()
    .from(guestOrderClaims)
    .where(eq(guestOrderClaims.checkoutGroupId, checkoutGroupId))
    .orderBy(desc(guestOrderClaims.createdAt))
    .limit(limit);
}

/** One consistency finding: a count over the whole table plus a bounded sample. */
export interface ClaimConsistencyFinding {
  readonly count: number;
  readonly sample: string[];
}

/** Hard ceiling on the ids one finding returns. */
const CLAIM_CONSISTENCY_SAMPLE = 20;

/**
 * The two cross-table claim invariants no CHECK can express (#109 revocation
 * rule 8).
 *
 * Each compares a claim row against the ORDERS it is about, which live in
 * another table — so neither is expressible as a constraint, and both should
 * always answer zero. Read-only, deliberately: a drifting claim is a decision
 * about who owns a purchase, and #50's "nothing auto-rewrites financial history
 * to hide a mismatch" applies to an ownership record for the same reason it
 * applies to a ledger entry.
 */
export async function readClaimConsistency(
  db: DatabaseOrTransaction,
): Promise<{
  claimOrderDrift: ClaimConsistencyFinding;
  unrecordedClaims: ClaimConsistencyFinding;
}> {
  const [drift, unrecorded] = await Promise.all([
    /**
     * Completed claims whose group has an order NOT carrying that claimant.
     *
     * The claim stamps every sibling under one lock, so the way this becomes
     * nonzero is an order INSERTED into an already-claimed group — which
     * nothing does today and which a future checkout-resume path could.
     *
     * `is distinct from` rather than `<>`, for `partiallyClaimedGroups`'
     * reason one table over: an UNCLAIMED sibling has NULL there, and `<>`
     * would evaluate to NULL and quietly report a half-claimed group as
     * consistent — which is the exact drift being looked for.
     */
    db.execute<{ id: string; total: string }>(sql`
      select c.id, count(*) over () as total
        from guest_order_claims c
       where c.state = 'completed'
         and exists (select 1
                       from orders o
                      where o.checkout_group_id = c.checkout_group_id
                        and o.claimed_by_oxy_user_id is distinct from c.claimed_by_oxy_user_id)
       limit ${CLAIM_CONSISTENCY_SAMPLE}
    `),
    /**
     * Orders carrying a claimant with no completed claim naming their group.
     *
     * `orders.claimed_by_oxy_user_id` has exactly one writer; a row here means
     * something else wrote it, which is the fact ADR 0003 I6 rests on.
     */
    db.execute<{ id: string; total: string }>(sql`
      select o.id, count(*) over () as total
        from orders o
       where o.claimed_by_oxy_user_id is not null
         and not exists (select 1
                           from guest_order_claims c
                          where c.checkout_group_id = o.checkout_group_id
                            and c.state = 'completed'
                            and c.claimed_by_oxy_user_id = o.claimed_by_oxy_user_id)
       limit ${CLAIM_CONSISTENCY_SAMPLE}
    `),
  ]);

  return {
    claimOrderDrift: toFinding(drift),
    unrecordedClaims: toFinding(unrecorded),
  };
}

/**
 * Turn a bounded probe into a finding.
 *
 * `count(*) over ()` is the whole reason the count is honest: the LIMIT bounds
 * what comes back, not what is counted, so a hundred offenders report a hundred
 * with twenty ids beside them rather than reporting twenty. The
 * `readBuyerIdentityConsistency` shape, verbatim.
 */
function toFinding(rows: readonly { id: string; total: string }[]): ClaimConsistencyFinding {
  return {
    // `count(*) over ()` decodes as a STRING through postgres.js (it is a
    // bigint on the wire), so it is coerced here rather than trusted to be the
    // number its TypeScript type claims.
    count: rows.length === 0 ? 0 : Number(rows[0].total),
    sample: rows.map((row) => row.id),
  };
}
