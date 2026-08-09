/**
 * The append-only record of every source that was tried (#122 selection 7).
 *
 * `on conflict (request_fingerprint, sequence) do nothing`, so a replayed
 * sourcing run converges on the rows it already wrote instead of doubling the
 * trail — the `moderation_events` claim shape applied to an audit. There is
 * deliberately no update and no delete here, and a trigger refuses both at the
 * table, because an attempt trail somebody can edit answers no question worth
 * asking.
 */

import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { SupplierSourcingOutcome, SupplierSourcingReason } from '@mercaria/shared-types';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { supplierSourcingAttempts } from '../schema/supplierPreflight.js';

/** Every column a caller may see — the keyed request digest withheld. */
const PUBLIC_ATTEMPT_COLUMNS = publicColumns(supplierSourcingAttempts, PROTECTED_COLUMNS);

/** One attempt row, without the request digest. */
export type SupplierSourcingAttemptRow = SelectedRow<typeof PUBLIC_ATTEMPT_COLUMNS>;

/** One candidate that was considered, and what became of it. */
export interface NewSupplierSourcingAttempt {
  requestFingerprint: string;
  sequence: number;
  checkoutGroupId: string | null;
  supplierId: string;
  supplierAccountId: string;
  procurementOfferId: string | null;
  sourcingPolicyId: string | null;
  sourcingPolicyKey: string | null;
  sourcingPolicyVersion: number | null;
  rank: number | null;
  outcome: SupplierSourcingOutcome;
  reason: SupplierSourcingReason;
  quoteId: string | null;
  at: Date;
}

/**
 * Record a run's attempts.
 *
 * Takes the whole list rather than one row at a time: the sequence numbers are
 * only meaningful together, and writing them in one statement means a crash
 * mid-run leaves either the whole trail or none of it, rather than a partial
 * ordering that reads as "we stopped trying here".
 */
export async function recordSupplierSourcingAttempts(
  attempts: readonly NewSupplierSourcingAttempt[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (attempts.length === 0) return 0;
  const inserted = await db
    .insert(supplierSourcingAttempts)
    .values(
      attempts.map((attempt) => ({
        requestFingerprint: attempt.requestFingerprint,
        sequence: attempt.sequence,
        checkoutGroupId: attempt.checkoutGroupId,
        supplierId: attempt.supplierId,
        supplierAccountId: attempt.supplierAccountId,
        procurementOfferId: attempt.procurementOfferId,
        sourcingPolicyId: attempt.sourcingPolicyId,
        sourcingPolicyKey: attempt.sourcingPolicyKey,
        sourcingPolicyVersion: attempt.sourcingPolicyVersion,
        rank: attempt.rank,
        outcome: attempt.outcome,
        reason: attempt.reason,
        quoteId: attempt.quoteId,
        at: attempt.at,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: supplierSourcingAttempts.id });
  return inserted.length;
}

/**
 * One run's trail, in attempt order.
 *
 * The fingerprint is named EXPLICITLY in the predicate — a protected column may
 * be matched against, it may just not be returned, and this is the one query
 * that legitimately needs to.
 */
export async function listSupplierSourcingAttemptsForRequest(
  requestFingerprint: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingAttemptRow[]> {
  return db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierSourcingAttempts)
    .where(eq(supplierSourcingAttempts.requestFingerprint, requestFingerprint))
    .orderBy(asc(supplierSourcingAttempts.sequence));
}

/** One checkout group's whole sourcing history — the operator trace. */
export async function listSupplierSourcingAttemptsForCheckoutGroup(
  checkoutGroupId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingAttemptRow[]> {
  return db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierSourcingAttempts)
    .where(eq(supplierSourcingAttempts.checkoutGroupId, checkoutGroupId))
    .orderBy(asc(supplierSourcingAttempts.at), asc(supplierSourcingAttempts.sequence));
}

/** Recent attempts against one account — the health investigation's starting page. */
export async function listRecentSupplierSourcingAttempts(
  input: { supplierAccountId: string; since: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingAttemptRow[]> {
  return db
    .select(PUBLIC_ATTEMPT_COLUMNS)
    .from(supplierSourcingAttempts)
    .where(
      and(
        eq(supplierSourcingAttempts.supplierAccountId, input.supplierAccountId),
        gt(supplierSourcingAttempts.at, input.since),
      ),
    )
    .orderBy(desc(supplierSourcingAttempts.at))
    .limit(input.limit);
}
