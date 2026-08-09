/**
 * Manual eligibility exceptions (#121 operations 4) — the audited, dual-approved
 * path by which a NAMED, WAIVABLE reason stops blocking.
 *
 * ## Three walls, and only one of them is in this file
 *
 * 1. **The database** refuses to store an unwaivable reason at all
 *    (`retail_eligibility_exceptions_waived_reasons_check` against
 *    `RETAIL_WAIVABLE_REASONS`), so no recall, suppression, prohibited category,
 *    ambiguous match, missing or expired evidence, unresolved tax treatment or
 *    unavailable refund rail can be waived by anybody.
 * 2. **The policy version** decides whether exceptions exist at all
 *    (`manual_exceptions_permitted`, default FALSE) and whether two approvers
 *    are required (`exception_dual_approval_required`, default TRUE). The
 *    DERIVATION reads both, so a waiver recorded under a version that forbids
 *    them waives nothing.
 * 3. **This file** refuses the request early with a message that names the
 *    offending reason, because a 500 from a CHECK teaches nobody anything.
 *
 * The order matters: the wall is the database, this is the sign on it.
 */

import {
  RETAIL_UNWAIVABLE_REASONS,
  RETAIL_WAIVABLE_REASONS,
  type RetailEligibilityReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  approveRetailEligibilityException,
  insertRetailEligibilityException,
  rejectRetailEligibilityException,
  revokeRetailEligibilityException,
  secondApproveRetailEligibilityException,
  type NewRetailEligibilityException,
  type RetailEligibilityExceptionRecord,
} from '../../db/retailEligibility/exceptionRepository.js';
import { appendRetailEligibilityAudit } from '../../db/retailEligibility/decisionRepository.js';
import { findRetailEligibilityPolicyById } from '../../db/retailEligibility/policyRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';

/**
 * Refuse a waiver over a reason no exception may ever cover, naming it.
 *
 * Exported so the same refusal is available to a caller that wants to explain
 * BEFORE composing a request — and pure, so the message is reproducible in a
 * test and in an operator's terminal.
 */
export function assertReasonsAreWaivable(reasons: readonly RetailEligibilityReason[]): void {
  const unwaivable = reasons.filter((reason) => RETAIL_UNWAIVABLE_REASONS.includes(reason));
  if (unwaivable.length === 0) return;
  throw validationError(
    `An eligibility exception can never waive ${unwaivable.join(', ')}. Waiving a recall, a ` +
      'suppression, a prohibited category, an ambiguous product match, missing or expired ' +
      'resale or compliance evidence, an unresolved tax treatment or an unavailable refund ' +
      `rail would put an unsafe or unsellable product in a buyer's hands. The waivable set is ` +
      `${RETAIL_WAIVABLE_REASONS.join(', ')}.`,
  );
}

/** Request a waiver, audited. It waives nothing until approved. */
export async function requestRetailEligibilityException(
  input: NewRetailEligibilityException & { reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityExceptionRecord> {
  assertReasonsAreWaivable(input.waivedReasons);

  const policy = await findRetailEligibilityPolicyById(db, input.policyId);
  if (!policy) throw notFound(`Retail eligibility policy ${input.policyId} does not exist.`);
  if (!policy.manualExceptionsPermitted) {
    await appendRetailEligibilityAudit(db, {
      action: 'exception_requested',
      subjectTable: 'retail_eligibility_policies',
      subjectId: policy.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.requestedByOxyUserId,
      detail: 'the policy version permits no manual exception',
    });
    throw conflict(
      `Policy version ${policy.policyKey} v${policy.version} permits no manual exception. ` +
        'Publishing a new version that does is a deliberate, audited act.',
    );
  }

  const row = await insertRetailEligibilityException(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'exception_requested',
    subjectTable: 'retail_eligibility_exceptions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.requestedByOxyUserId,
    detail: `waives ${row.waivedReasons.join(', ')}`,
  });
  return row;
}

/**
 * Approve a waiver, audited.
 *
 * Records the FIRST approval, or the SECOND if a first is already present. The
 * CHECKs then refuse the same person twice and refuse the requester approving
 * their own request — so "two distinct operators" is the row's shape rather
 * than a comparison this function has to remember.
 */
export async function approveRetailEligibilityExceptionAudited(
  input: { id: string; approvedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityExceptionRecord> {
  const first = await approveRetailEligibilityException(db, input);
  const row = first ?? (await secondApproveRetailEligibilityException(db, input));
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'exception_approved',
      subjectTable: 'retail_eligibility_exceptions',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.approvedByOxyUserId,
      detail: 'not awaiting a first or a second approval',
    });
    throw conflict(
      `Eligibility exception ${input.id} is not awaiting an approval. A rejected or revoked ` +
        'waiver is replaced, never re-approved.',
    );
  }
  await appendRetailEligibilityAudit(db, {
    action: 'exception_approved',
    subjectTable: 'retail_eligibility_exceptions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.approvedByOxyUserId,
    detail: first ? 'first approval' : 'second approval',
  });
  return row;
}

/** Refuse a waiver, audited. */
export async function rejectRetailEligibilityExceptionAudited(
  input: { id: string; rejectedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityExceptionRecord> {
  const row = await rejectRetailEligibilityException(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'exception_rejected',
      subjectTable: 'retail_eligibility_exceptions',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.rejectedByOxyUserId,
      detail: 'not awaiting a decision',
    });
    throw conflict(`Eligibility exception ${input.id} is not awaiting a decision.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'exception_rejected',
    subjectTable: 'retail_eligibility_exceptions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.rejectedByOxyUserId,
  });
  return row;
}

/** Withdraw an approved waiver, audited. The offers it covered block again. */
export async function revokeRetailEligibilityExceptionAudited(
  input: { id: string; revokedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityExceptionRecord> {
  const row = await revokeRetailEligibilityException(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'exception_revoked',
      subjectTable: 'retail_eligibility_exceptions',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.revokedByOxyUserId,
      detail: 'not approved',
    });
    throw conflict(`Eligibility exception ${input.id} is not approved, so there is nothing to withdraw.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'exception_revoked',
    subjectTable: 'retail_eligibility_exceptions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.revokedByOxyUserId,
  });
  return row;
}
