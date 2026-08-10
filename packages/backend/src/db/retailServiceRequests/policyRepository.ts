/**
 * `retail_service_policy_exceptions` and `retail_dispute_coordinations` — the two
 * tables that decide whether a request may proceed at all.
 *
 * They live together because they answer the same question from opposite
 * directions: an exception says *this remedy does not exist for these goods in
 * this market*, and a coordination says *this remedy exists and its money is
 * suspended while a card network decides*. Both are read by the eligibility and
 * refund paths and by nothing else, and neither has an operator write that could
 * silently widen the other.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  RetailPolicyExceptionSource,
  RetailRefundSuspensionState,
  RetailServiceRequestKind,
} from '@mercaria/shared-types';
import {
  retailDisputeCoordinations,
  retailServicePolicyExceptions,
} from '../schema/retailServiceRequests.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** An exception as stored. */
export type RetailServicePolicyExceptionRow =
  typeof retailServicePolicyExceptions.$inferSelect;

/** A dispute coordination as stored. */
export type RetailDisputeCoordinationRow = typeof retailDisputeCoordinations.$inferSelect;

/** Publish one exception. Immutable afterwards by trigger. */
export async function insertRetailServicePolicyException(
  input: {
    market: string;
    categoryId: string;
    excludedKinds: readonly RetailServiceRequestKind[];
    source: RetailPolicyExceptionSource;
    legalBasis: string;
    requestedByOxyUserId: string;
    reviewedByOxyUserId: string;
    reviewedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServicePolicyExceptionRow> {
  const [row] = await db
    .insert(retailServicePolicyExceptions)
    .values({
      market: input.market,
      categoryId: input.categoryId,
      excludedKinds: [...input.excludedKinds],
      source: input.source,
      legalBasis: input.legalBasis,
      requestedByOxyUserId: input.requestedByOxyUserId,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      reviewedAt: input.reviewedAt,
    })
    .returning();
  if (!row) throw new Error('the retail policy exception insert returned no row');
  return row;
}

/**
 * The LIVE exception covering one market and one of the named categories, if
 * there is one.
 *
 * Takes the category set rather than one category because an order line's goods
 * sit in a category tree and every ancestor's exception applies — the caller
 * resolves the ancestry and this reads the whole set in one statement. `null` is
 * the ordinary answer and the ordinary answer must be cheap.
 */
export async function findLiveRetailPolicyException(
  input: {
    market: string;
    categoryIds: readonly string[];
    kind: RetailServiceRequestKind;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServicePolicyExceptionRow | undefined> {
  if (input.categoryIds.length === 0) return undefined;
  const [row] = await db
    .select()
    .from(retailServicePolicyExceptions)
    .where(
      and(
        eq(retailServicePolicyExceptions.market, input.market),
        // `sql.param` binds the array as ONE parameter; a bare array renders as
        // a ROW constructor Postgres rejects.
        sql`${retailServicePolicyExceptions.categoryId} = any(${sql.param([
          ...input.categoryIds,
        ])}::text[])`,
        sql`${input.kind} = any(${retailServicePolicyExceptions.excludedKinds})`,
        isNull(retailServicePolicyExceptions.withdrawnAt),
      ),
    )
    .limit(1);
  return row;
}

/** Every live exception, newest first — the operator's list. */
export async function listLiveRetailPolicyExceptions(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServicePolicyExceptionRow[]> {
  return db
    .select()
    .from(retailServicePolicyExceptions)
    .where(isNull(retailServicePolicyExceptions.withdrawnAt))
    .orderBy(desc(retailServicePolicyExceptions.reviewedAt))
    .limit(limit);
}

/** Withdraw one exception. The row stays, for the requests it decided. */
export async function withdrawRetailPolicyException(
  input: { id: string; byOxyUserId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailServicePolicyExceptionRow | undefined> {
  const [row] = await db
    .update(retailServicePolicyExceptions)
    .set({ withdrawnAt: input.at, withdrawnByOxyUserId: input.byOxyUserId })
    .where(
      and(
        eq(retailServicePolicyExceptions.id, input.id),
        isNull(retailServicePolicyExceptions.withdrawnAt),
      ),
    )
    .returning();
  return row;
}

/**
 * Open or converge one dispute coordination.
 *
 * `ON CONFLICT DO NOTHING` plus a read on the dispute's own unique, so a
 * redelivered `charge.dispute.created` produces one coordination and does not
 * re-suspend a refund an operator has since released.
 */
export async function ensureRetailDisputeCoordination(
  input: { disputeId: string; orderId: string; serviceRequestId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ row: RetailDisputeCoordinationRow; created: boolean }> {
  const inserted = await db
    .insert(retailDisputeCoordinations)
    .values({
      disputeId: input.disputeId,
      orderId: input.orderId,
      serviceRequestId: input.serviceRequestId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(retailDisputeCoordinations)
    .where(eq(retailDisputeCoordinations.disputeId, input.disputeId));
  if (!existing) {
    throw new Error(`dispute coordination for ${input.disputeId} neither inserted nor found`);
  }
  return { row: existing, created: false };
}

/**
 * Is anything suspending refunds on this order?
 *
 * The refund gate's whole read, and it is an index probe over the suspended rows
 * alone. Returning the ROW rather than a boolean so the refusal can name the
 * dispute an operator has to look at — a bare `true` sends somebody hunting.
 */
export async function findRetailRefundSuspension(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailDisputeCoordinationRow | undefined> {
  const [row] = await db
    .select()
    .from(retailDisputeCoordinations)
    .where(
      and(
        eq(retailDisputeCoordinations.orderId, orderId),
        eq(retailDisputeCoordinations.suspension, 'suspended'),
      ),
    )
    .orderBy(asc(retailDisputeCoordinations.createdAt))
    .limit(1);
  return row;
}

/** Set a coordination's suspension. A release is attributable by CHECK. */
export async function setRetailRefundSuspension(
  input: {
    id: string;
    suspension: RetailRefundSuspensionState;
    reason?: string;
    byOxyUserId?: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailDisputeCoordinationRow | undefined> {
  const [row] = await db
    .update(retailDisputeCoordinations)
    .set({
      suspension: input.suspension,
      suspensionReason: input.reason ?? null,
      releasedByOxyUserId: input.byOxyUserId ?? null,
      releasedAt: input.at ?? null,
    })
    .where(eq(retailDisputeCoordinations.id, input.id))
    .returning();
  return row;
}

/** Mark the evidence for a dispute as assembled. */
export async function markRetailDisputeEvidenceAssembled(
  input: { id: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(retailDisputeCoordinations)
    .set({ evidenceAssembledAt: input.at })
    .where(eq(retailDisputeCoordinations.id, input.id));
}

/** The coordination for one dispute, if there is one. */
export async function findRetailDisputeCoordination(
  disputeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailDisputeCoordinationRow | undefined> {
  const [row] = await db
    .select()
    .from(retailDisputeCoordinations)
    .where(eq(retailDisputeCoordinations.disputeId, disputeId));
  return row;
}

/** Every coordination on one order. */
export async function listRetailDisputeCoordinationsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailDisputeCoordinationRow[]> {
  return db
    .select()
    .from(retailDisputeCoordinations)
    .where(eq(retailDisputeCoordinations.orderId, orderId))
    .orderBy(desc(retailDisputeCoordinations.createdAt));
}
