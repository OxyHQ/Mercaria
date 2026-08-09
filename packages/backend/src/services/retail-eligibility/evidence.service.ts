/**
 * Recording and reviewing evidence (#121 "Resale authorization", "Safety and
 * regulatory evidence", operations 1–3).
 *
 * Every act here writes an AUDIT row — including the refusals, which is the
 * half that is easy to skip and the half an incident asks about. The
 * `payment_repairs` shape: one row per attempt, mandatory actor, mandatory
 * reason.
 *
 * ## Recording a document never widens what Mercaria may sell
 *
 * Evidence arrives `unknown`, and `unknown` authorizes nothing. Only a
 * verification by a named reviewer at a recorded time makes a document
 * effective, and only until its deadline — which is read against the clock, not
 * stored.
 */

import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  insertRetailComplianceEvidence,
  insertRetailResaleEvidence,
  rejectRetailComplianceEvidence,
  rejectRetailResaleEvidence,
  revokeRetailComplianceEvidence,
  revokeRetailResaleEvidence,
  verifyRetailComplianceEvidence,
  verifyRetailResaleEvidence,
  type NewRetailComplianceEvidence,
  type NewRetailResaleEvidence,
  type RetailComplianceEvidenceRecord,
  type RetailResaleEvidenceRecord,
} from '../../db/retailEligibility/evidenceRepository.js';
import { appendRetailEligibilityAudit } from '../../db/retailEligibility/decisionRepository.js';
import { conflict } from '../../lib/errors/error-codes.js';
import { assertNoForbiddenResaleEvidence } from './forbidden-evidence.js';

/**
 * Record a piece of resale evidence, audited.
 *
 * The kind is already constrained to the allowed tuple by the column's CHECK
 * and by the request schema's enum. What runs here first is the REFUSAL that
 * names an insufficient offering by its prohibition, over the free-text issuer
 * and note the caller also sent — because "issuer: our affiliate dashboard" is
 * the shape this rule actually has to catch in practice, and it arrives as
 * prose rather than as a kind.
 */
export async function recordResaleEvidence(
  input: NewRetailResaleEvidence & { reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailResaleEvidenceRecord> {
  assertNoForbiddenResaleEvidence(
    [input.kind, ...(input.issuer ? [input.issuer] : []), ...(input.note ? [input.note] : [])],
    'Retail resale evidence',
  );
  const row = await insertRetailResaleEvidence(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'resale_evidence_recorded',
    subjectTable: 'retail_resale_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.recordedByOxyUserId,
    detail: `${row.kind} for supplier ${row.supplierId}`,
  });
  return row;
}

/** Verify a resale document, audited on both outcomes. */
export async function verifyResaleEvidence(
  input: { id: string; verifiedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailResaleEvidenceRecord> {
  const row = await verifyRetailResaleEvidence(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'resale_evidence_verified',
      subjectTable: 'retail_resale_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.verifiedByOxyUserId,
      detail: 'not awaiting review',
    });
    throw conflict(
      `Resale evidence ${input.id} is not awaiting review, so it cannot be verified. ` +
        'A rejected or revoked document is replaced, never re-verified.',
    );
  }
  await appendRetailEligibilityAudit(db, {
    action: 'resale_evidence_verified',
    subjectTable: 'retail_resale_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.verifiedByOxyUserId,
  });
  return row;
}

/** Refuse a resale document, audited. */
export async function rejectResaleEvidence(
  input: { id: string; actorOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailResaleEvidenceRecord> {
  const row = await rejectRetailResaleEvidence(db, { id: input.id, reason: input.reason });
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'resale_evidence_rejected',
      subjectTable: 'retail_resale_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId,
      detail: 'not awaiting review',
    });
    throw conflict(`Resale evidence ${input.id} is not awaiting review.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'resale_evidence_rejected',
    subjectTable: 'retail_resale_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.actorOxyUserId,
  });
  return row;
}

/** Withdraw a resale verification, audited. */
export async function revokeResaleEvidence(
  input: { id: string; revokedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailResaleEvidenceRecord> {
  const row = await revokeRetailResaleEvidence(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'resale_evidence_revoked',
      subjectTable: 'retail_resale_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.revokedByOxyUserId,
      detail: 'not verified',
    });
    throw conflict(
      `Resale evidence ${input.id} is not verified, so there is no authority to withdraw.`,
    );
  }
  await appendRetailEligibilityAudit(db, {
    action: 'resale_evidence_revoked',
    subjectTable: 'retail_resale_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.revokedByOxyUserId,
  });
  return row;
}

/** Record a compliance document, audited. */
export async function recordComplianceEvidence(
  input: NewRetailComplianceEvidence & { reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailComplianceEvidenceRecord> {
  const row = await insertRetailComplianceEvidence(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'compliance_evidence_recorded',
    subjectTable: 'retail_compliance_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.recordedByOxyUserId,
    detail: `${row.kind} for supplier ${row.supplierId}`,
  });
  return row;
}

/** Verify a compliance document, audited on both outcomes. */
export async function verifyComplianceEvidence(
  input: { id: string; verifiedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailComplianceEvidenceRecord> {
  const row = await verifyRetailComplianceEvidence(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'compliance_evidence_verified',
      subjectTable: 'retail_compliance_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.verifiedByOxyUserId,
      detail: 'not awaiting review',
    });
    throw conflict(`Compliance evidence ${input.id} is not awaiting review.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'compliance_evidence_verified',
    subjectTable: 'retail_compliance_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.verifiedByOxyUserId,
  });
  return row;
}

/** Refuse a compliance document, audited. */
export async function rejectComplianceEvidence(
  input: { id: string; actorOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailComplianceEvidenceRecord> {
  const row = await rejectRetailComplianceEvidence(db, { id: input.id, reason: input.reason });
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'compliance_evidence_rejected',
      subjectTable: 'retail_compliance_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId,
      detail: 'not awaiting review',
    });
    throw conflict(`Compliance evidence ${input.id} is not awaiting review.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'compliance_evidence_rejected',
    subjectTable: 'retail_compliance_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.actorOxyUserId,
  });
  return row;
}

/** Withdraw a compliance verification, audited. */
export async function revokeComplianceEvidence(
  input: { id: string; revokedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailComplianceEvidenceRecord> {
  const row = await revokeRetailComplianceEvidence(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'compliance_evidence_revoked',
      subjectTable: 'retail_compliance_evidence',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.revokedByOxyUserId,
      detail: 'not verified',
    });
    throw conflict(`Compliance evidence ${input.id} is not verified.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'compliance_evidence_revoked',
    subjectTable: 'retail_compliance_evidence',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.revokedByOxyUserId,
  });
  return row;
}
