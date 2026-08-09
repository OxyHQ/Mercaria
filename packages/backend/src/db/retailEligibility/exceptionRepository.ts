/**
 * Manual eligibility exceptions (#121 operations 4).
 *
 * ## An exception is DATA, never a parameter
 *
 * `getRetailEligibility` has no override argument. What can change a verdict is
 * a row here — requested by somebody, approved by two DISTINCT operators,
 * scoped, expiring, and naming exactly which reasons it waives — so every
 * override sits inside the same audit trail as everything else and a client
 * cannot construct one.
 *
 * ## The unwaivable set is the database's, not this module's
 *
 * `waived_reasons` is containment-CHECKed against `RETAIL_WAIVABLE_REASONS`, so
 * no function here needs to remember that a recall, a suppression, a prohibited
 * category, an ambiguous product match, missing or expired evidence, an
 * unresolved tax treatment or an unavailable refund rail can never be waived —
 * the INSERT fails. That is deliberate: those are precisely the refusals a
 * person under pressure would most want to wave through.
 *
 * ## Four eyes is the row's shape
 *
 * The CHECKs require the two approvers to differ from each other AND from the
 * requester, and refuse a second approval with no first. Whether the second is
 * REQUIRED is the policy version's `exception_dual_approval_required`, read by
 * the derivation — so a version that demands it cannot be satisfied by one
 * operator approving twice under two names it does not have.
 */

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { RetailEligibilityReason } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { retailEligibilityExceptions } from '../schema/retailEligibility.js';

/** One exception row, whole. */
export type RetailEligibilityExceptionRecord = typeof retailEligibilityExceptions.$inferSelect;

/** What requesting one records. */
export interface NewRetailEligibilityException {
  policyId: string;
  supplierId: string;
  canonicalVariantId?: string;
  scopeDestinationCountries?: string[];
  waivedReasons: RetailEligibilityReason[];
  justification: string;
  requestedByOxyUserId: string;
  requestedAt?: Date;
  expiresAt: Date;
}

/** Request a waiver. It waives nothing until approved. */
export async function insertRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: NewRetailEligibilityException,
): Promise<RetailEligibilityExceptionRecord> {
  const [row] = await db
    .insert(retailEligibilityExceptions)
    .values({
      policyId: input.policyId,
      supplierId: input.supplierId,
      canonicalVariantId: input.canonicalVariantId ?? null,
      scopeDestinationCountries:
        input.scopeDestinationCountries?.map((code) => code.toUpperCase()) ?? [],
      waivedReasons: input.waivedReasons,
      justification: input.justification,
      requestedByOxyUserId: input.requestedByOxyUserId,
      requestedAt: input.requestedAt ?? new Date(),
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error('insertRetailEligibilityException returned no row');
  return row;
}

/** One row by id — the operator surface's addressing. */
export async function findRetailEligibilityExceptionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailEligibilityExceptions)
    .where(eq(retailEligibilityExceptions.id, id))
    .limit(1);
  return row;
}

/**
 * Record the FIRST approval. A CAS from `requested`, so two operators clicking
 * approve at the same moment produce one first approval and one loser who then
 * becomes the second approver through {@link secondApproveRetailEligibilityException}.
 *
 * The state moves to `approved` here even when the policy demands two: the
 * derivation checks `secondApprovedByOxyUserId` itself, so a half-approved
 * waiver under a dual-approval version waives nothing while remaining visibly
 * half-approved — which is the state an operator needs to see in the queue.
 */
export async function approveRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailEligibilityExceptions)
    .set({
      state: 'approved',
      approvedByOxyUserId: input.approvedByOxyUserId,
      approvedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailEligibilityExceptions.id, input.id),
        eq(retailEligibilityExceptions.state, 'requested'),
      ),
    )
    .returning();
  return row;
}

/**
 * Record the SECOND approval. Only onto a row that already has a first and none
 * of its own; the CHECK then refuses the same person twice, which is what makes
 * "two distinct operators" a property of the row rather than of this function.
 */
export async function secondApproveRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailEligibilityExceptions)
    .set({
      secondApprovedByOxyUserId: input.approvedByOxyUserId,
      secondApprovedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailEligibilityExceptions.id, input.id),
        eq(retailEligibilityExceptions.state, 'approved'),
        isNull(retailEligibilityExceptions.secondApprovedByOxyUserId),
      ),
    )
    .returning();
  return row;
}

/** Refuse a waiver. The reason is mandatory and is what the CHECK demands. */
export async function rejectRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: { id: string; rejectedByOxyUserId: string; reason: string; at?: Date },
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailEligibilityExceptions)
    .set({
      state: 'rejected',
      rejectedByOxyUserId: input.rejectedByOxyUserId,
      rejectedAt: at,
      rejectionReason: input.reason,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailEligibilityExceptions.id, input.id),
        eq(retailEligibilityExceptions.state, 'requested'),
      ),
    )
    .returning();
  return row;
}

/** Withdraw an approved waiver. Only an approved one can be revoked. */
export async function revokeRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; reason: string; at?: Date },
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailEligibilityExceptions)
    .set({
      state: 'revoked',
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokedAt: at,
      revocationReason: input.reason,
      updatedAt: at,
    })
    .where(
      and(
        eq(retailEligibilityExceptions.id, input.id),
        eq(retailEligibilityExceptions.state, 'approved'),
      ),
    )
    .returning();
  return row;
}

/**
 * The live approved waiver covering one supplier and variant, if any — the
 * derivation's read.
 *
 * A variant-scoped waiver wins over a supplier-wide one, because the narrower
 * statement is the more deliberate: somebody looked at that exact product.
 * `expires_at > now` is applied here AND re-checked in the derivation, on
 * purpose — the query is an optimisation and the derivation is the authority,
 * so a caller supplying its own facts (a test, a what-if trace) gets the same
 * answer as one reading the database.
 */
export async function findLiveRetailEligibilityException(
  db: DatabaseOrTransaction,
  input: { supplierId: string; canonicalVariantId: string | null; now?: Date },
): Promise<RetailEligibilityExceptionRecord | undefined> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(retailEligibilityExceptions)
    .where(
      and(
        eq(retailEligibilityExceptions.supplierId, input.supplierId),
        eq(retailEligibilityExceptions.state, 'approved'),
        gt(retailEligibilityExceptions.expiresAt, now),
        input.canonicalVariantId
          ? or(
              isNull(retailEligibilityExceptions.canonicalVariantId),
              eq(retailEligibilityExceptions.canonicalVariantId, input.canonicalVariantId),
            )
          : isNull(retailEligibilityExceptions.canonicalVariantId),
      ),
    )
    .orderBy(desc(retailEligibilityExceptions.canonicalVariantId));
  return rows[0];
}

/** The review queue: waivers awaiting a decision, or awaiting a second approver. */
export async function listRetailEligibilityExceptions(
  db: DatabaseOrTransaction,
  filter?: { states?: RetailEligibilityExceptionRecord['state'][]; limit?: number },
): Promise<RetailEligibilityExceptionRecord[]> {
  const states = filter?.states ?? ['requested', 'approved'];
  return await db
    .select()
    .from(retailEligibilityExceptions)
    .where(inArray(retailEligibilityExceptions.state, states))
    .orderBy(desc(retailEligibilityExceptions.requestedAt))
    .limit(filter?.limit ?? 100);
}
