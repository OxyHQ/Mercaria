/**
 * Verified organization / brand / official-store relationships (#55, ADR 0002
 * D10/D11/D17) — assertion, evidence and the operator review workflow.
 *
 * The one sentence that governs this file: **nothing here can produce a public
 * badge from a name, a logo or a domain.** Reaching `verified` requires an
 * operator decision (or an explicit trusted rule, of which there are none), at
 * least one ACTIVE evidence row of a kind sufficient for that relationship kind,
 * and — for the two badge-producing kinds — two distinct operators. Each of
 * those three is enforced somewhere that a later caller cannot route around:
 * the first in `relationship-authority.ts`, the second in the same module
 * reading a shared-types table, the third in a partial unique index.
 *
 * ## Public reads live in `relationship-resolution.ts`
 *
 * This file is the WRITE side plus the operator reads. The question a product
 * page asks — "is this merchant an official channel for this brand in this
 * market right now" — is answered there, from a projection with no field for
 * evidence, reviewer notes or actor ids to ride along in.
 */

import type {
  OperatorCommerceRelationship,
  PublicRelationshipBadge,
  RelationshipAssertedByKind,
  RelationshipCandidate,
  RelationshipConflict,
  RelationshipEntityKind,
  RelationshipEvidence as RelationshipEvidenceDTO,
  RelationshipEvidenceKind,
  RelationshipKind,
  RelationshipReview as RelationshipReviewDTO,
  RelationshipVerificationMethod,
  RelationshipVerificationState,
} from '@mercaria/shared-types';
import { RELATIONSHIP_KIND_DEFINITIONS } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  closeRelationship,
  findOpenRelationship,
  findPredecessor,
  findRelationshipById,
  insertEvidence,
  insertRelationship,
  insertReview,
  listApprovalsForRelationships,
  listApprovalsForRound,
  listEvidence,
  listEvidenceForRelationships,
  listRelationshipsByStatus,
  listRelationshipsForEntity,
  listReviews,
  markSuperseded,
  revokeEvidence,
  transitionRelationship,
  type CommerceRelationshipRow,
  type RelationshipEndpoints,
  type RelationshipEvidenceRow,
  type RelationshipReviewRow,
} from '../../db/commerce-graph/relationshipRepository.js';
import {
  acceptableEvidenceKinds,
  canAutoVerify,
  canTransition,
  findSufficientEvidence,
  maxReachableStatus,
  requiresFourEyes,
} from './relationship-authority.js';
import {
  detectConflicts,
  type ConflictCandidateRow,
  type ConflictEvidenceFact,
} from './relationship-conflicts.js';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/** The subject entity id of a row, by its kind's definition. */
function subjectIdOf(row: CommerceRelationshipRow): string {
  const id = endpointOf(row, RELATIONSHIP_KIND_DEFINITIONS[row.kind].subject, 'subject');
  return id;
}

/** The object entity id of a row, by its kind's definition. */
function objectIdOf(row: CommerceRelationshipRow): string {
  return endpointOf(row, RELATIONSHIP_KIND_DEFINITIONS[row.kind].object, 'object');
}

/**
 * Resolve one endpoint by entity kind and role.
 *
 * The brand→brand case is the reason `role` exists at all: both ends are brands,
 * so the entity kind alone cannot say which column to read. A throw rather than
 * a fallback — the per-kind CHECK guarantees the column is populated, so a NULL
 * here means the CHECK is gone, and a silently empty subject id would put the
 * wrong entity on a badge.
 */
function endpointOf(
  row: CommerceRelationshipRow,
  entityKind: RelationshipEntityKind,
  role: 'subject' | 'object',
): string {
  const value =
    entityKind === 'organization'
      ? row.organizationId
      : entityKind === 'merchant'
        ? row.merchantId
        : entityKind === 'product_family'
          ? row.productFamilyId
          : role === 'subject'
            ? row.brandId
            : RELATIONSHIP_KIND_DEFINITIONS[row.kind].subject === 'brand'
              ? row.relatedBrandId
              : row.brandId;
  if (value === null || value === undefined) {
    throw new Error(
      `Relationship ${row.id} of kind ${row.kind} has no ${role} endpoint; the per-kind ` +
        'CHECK that guarantees one is missing.',
    );
  }
  return value;
}

/** The badge a row would produce if it were current. Null for non-badge kinds. */
export function badgeOf(kind: RelationshipKind): PublicRelationshipBadge | null {
  return RELATIONSHIP_KIND_DEFINITIONS[kind].publicBadge;
}

/** The whole row, for the operator surface only. */
export function toOperatorRelationshipDTO(
  row: CommerceRelationshipRow,
  supersedesId: string | null,
): OperatorCommerceRelationship {
  const definition = RELATIONSHIP_KIND_DEFINITIONS[row.kind];
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: definition.subject,
    subjectId: subjectIdOf(row),
    objectKind: definition.object,
    objectId: objectIdOf(row),
    territories: row.territories,
    languages: row.languages,
    storefrontId: row.storefrontId,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    status: row.status,
    verificationMethod: row.verificationMethod,
    confidence: row.confidence,
    assertedByKind: row.assertedByKind,
    assertedBySourceId: row.assertedBySourceId,
    reviewRound: row.reviewRound,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokeReason: row.revokeReason,
    supersededById: row.supersededById,
    supersedesId,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toEvidenceDTO(row: RelationshipEvidenceRow): RelationshipEvidenceDTO {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    kind: row.kind,
    status: row.status,
    observedFact: row.observedFact,
    subjectDomain: row.subjectDomain,
    sourceUrl: row.sourceUrl,
    oxyFileId: row.oxyFileId,
    contentSha256: row.contentSha256,
    sourceRecordId: row.sourceRecordId,
    locale: row.locale,
    observedAt: row.observedAt.toISOString(),
    collectedAt: row.collectedAt.toISOString(),
    reviewerNote: row.reviewerNote,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokeReason: row.revokeReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toReviewDTO(row: RelationshipReviewRow): RelationshipReviewDTO {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    action: row.action,
    actorOxyUserId: row.actorOxyUserId,
    reason: row.reason,
    reviewRound: row.reviewRound,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A row, reduced to what the conflict detector reads. */
function toConflictRow(row: CommerceRelationshipRow): ConflictCandidateRow {
  return {
    id: row.id,
    kind: row.kind,
    organizationId: row.organizationId,
    brandId: row.brandId,
    merchantId: row.merchantId,
    productFamilyId: row.productFamilyId,
    relatedBrandId: row.relatedBrandId,
    storefrontId: row.storefrontId,
    territories: row.territories,
    status: row.status,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

export interface AssertRelationshipParams extends RelationshipEndpoints {
  kind: RelationshipKind;
  assertedByKind: RelationshipAssertedByKind;
  /** Required when `assertedByKind === 'ingestion_source'`, forbidden otherwise. */
  assertedBySourceId?: string;
  territories?: string[];
  languages?: string[];
  storefrontId?: string;
  validFrom?: Date;
  validTo?: Date;
  /** 0–1. Machine matching only — a human or platform assertion may not carry one. */
  confidence?: number;
  actorOxyUserId?: string;
  note?: string;
  /**
   * Whether the asserter wants a decision. A merchant self-claim with this set
   * lands in the queue; without it the row sits as a candidate. Ingestion may
   * not set it — see `maxReachableStatus`.
   */
  requestReview?: boolean;
}

/**
 * Create a relationship CLAIM. Never verified, whatever the caller asks for.
 *
 * The status is decided by {@link maxReachableStatus} from WHO is asserting,
 * not from anything in the request body — which is what makes "a source adapter
 * cannot mark it verified" a property of the code path rather than of a field
 * nobody set. Confidence rides along untouched and changes nothing: it is
 * recorded for #58's explanation surface and read by no gate here.
 */
export async function assertRelationship(
  params: AssertRelationshipParams,
): Promise<CommerceRelationshipRow> {
  const db = getDb();
  const territories = normalizeTerritories(params.territories ?? []);
  const languages = normalizeLanguages(params.languages ?? []);

  if (params.confidence !== undefined && params.assertedByKind !== 'ingestion_source') {
    throw validationError(
      'Confidence is a machine-matching score and may only accompany an ingestion-source ' +
        'assertion. A human or platform assertion carries evidence, not a probability.',
    );
  }
  if ((params.assertedBySourceId !== undefined) !== (params.assertedByKind === 'ingestion_source')) {
    throw validationError(
      'An ingestion-source assertion must name its catalog source, and nothing else may claim one.',
    );
  }

  const ceiling = maxReachableStatus(params.assertedByKind);
  const status: RelationshipVerificationState =
    params.requestReview === true && ceiling === 'pending_review' ? 'pending_review' : 'candidate';

  const endpoints: RelationshipEndpoints = {
    organizationId: params.organizationId,
    brandId: params.brandId,
    merchantId: params.merchantId,
    productFamilyId: params.productFamilyId,
    relatedBrandId: params.relatedBrandId,
  };

  const inserted = await insertRelationship(db, {
    kind: params.kind,
    ...endpoints,
    territories,
    languages,
    storefrontId: params.storefrontId,
    validFrom: params.validFrom ?? new Date(),
    validTo: params.validTo,
    status,
    assertedByKind: params.assertedByKind,
    assertedBySourceId: params.assertedBySourceId,
    confidence: params.confidence,
    createdByOxyUserId: params.actorOxyUserId,
    note: params.note,
  });

  if (!inserted) {
    // The index refused it. Read back so the refusal names the row that holds
    // the claim rather than reporting a bare constraint violation.
    const existing = await findOpenRelationship(db, {
      kind: params.kind,
      endpoints,
      storefrontId: params.storefrontId,
    });
    if (existing) {
      throw conflict(
        `An open ${params.kind} claim already exists for these endpoints (${existing.id}).`,
      );
    }
    throw conflict('The claim raced a concurrent change; retry.');
  }

  log.general.info(
    {
      relationshipId: inserted.id,
      kind: inserted.kind,
      status: inserted.status,
      assertedByKind: inserted.assertedByKind,
      territories: inserted.territories,
    },
    '[CommerceGraph] relationship claim recorded',
  );
  return inserted;
}

export interface AttachEvidenceParams {
  relationshipId: string;
  kind: RelationshipEvidenceKind;
  observedFact: string;
  subjectDomain?: string;
  sourceUrl?: string;
  oxyFileId?: string;
  contentSha256?: string;
  sourceRecordId?: string;
  locale?: string;
  observedAt?: Date;
  collectedByOxyUserId?: string;
  reviewerNote?: string;
  expiresAt?: Date;
}

/**
 * Attach one piece of proof.
 *
 * Attaching evidence is deliberately available to a self-claiming merchant and
 * to ingestion: evidence rule 3 says a self-claim PROVIDES evidence, it just is
 * not self-verifying. Nothing about this call moves a status.
 */
export async function attachEvidence(
  params: AttachEvidenceParams,
): Promise<RelationshipEvidenceRow> {
  if (params.observedFact.trim() === '') {
    throw validationError('Evidence must state the fact it records.');
  }
  const db = getDb();
  const relationship = await findRelationshipById(db, params.relationshipId);
  if (!relationship) throw notFound('Relationship not found');

  const row = await insertEvidence(db, {
    relationshipId: params.relationshipId,
    kind: params.kind,
    observedFact: params.observedFact.trim(),
    subjectDomain: params.subjectDomain?.trim().toLowerCase(),
    sourceUrl: params.sourceUrl,
    oxyFileId: params.oxyFileId,
    contentSha256: params.contentSha256,
    sourceRecordId: params.sourceRecordId,
    locale: params.locale,
    observedAt: params.observedAt ?? new Date(),
    collectedByOxyUserId: params.collectedByOxyUserId,
    reviewerNote: params.reviewerNote,
    expiresAt: params.expiresAt,
  });
  log.general.info(
    { relationshipId: params.relationshipId, evidenceId: row.id, kind: row.kind },
    '[CommerceGraph] relationship evidence attached',
  );
  return row;
}

/**
 * Revoke a piece of proof. The relationship it backed is NOT touched (evidence
 * rule 5): history is not rewritten by a proof lapsing, and the resulting
 * `verified_without_active_evidence` conflict is the operator's to decide.
 */
export async function revokeRelationshipEvidence(params: {
  evidenceId: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<RelationshipEvidenceRow> {
  if (params.reason.trim() === '') {
    throw validationError('Revoking evidence requires a reason.');
  }
  const db = getDb();
  const row = await revokeEvidence(db, {
    id: params.evidenceId,
    revokedByOxyUserId: params.actorOxyUserId,
    revokedAt: new Date(),
    reason: params.reason,
  });
  if (!row) throw notFound('No active evidence with that id.');
  log.general.info(
    {
      evidenceId: row.id,
      relationshipId: row.relationshipId,
      actorOxyUserId: params.actorOxyUserId,
    },
    '[CommerceGraph] relationship evidence revoked',
  );
  return row;
}

/**
 * Record an operator's ENDORSEMENT of the current review round without moving
 * the status — the first half of a four-eyes approval.
 *
 * A second endorsement by the same operator is refused by the partial unique,
 * not by a comparison here, which is what makes "two distinct operators" hold
 * against a concurrent double-click as well as against a careless caller.
 */
export async function endorseRelationship(params: {
  relationshipId: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<RelationshipReviewRow> {
  if (params.reason.trim() === '') {
    throw validationError('An approval requires a reason.');
  }
  const db = getDb();
  const relationship = await findRelationshipById(db, params.relationshipId);
  if (!relationship) throw notFound('Relationship not found');
  if (relationship.status === 'verified') {
    throw conflict('This relationship is already verified.');
  }
  if (!canTransition(relationship.status, 'verified')) {
    throw conflict(`A ${relationship.status} relationship cannot be verified.`);
  }

  const review = await insertReview(db, {
    relationshipId: params.relationshipId,
    action: 'approve',
    actorOxyUserId: params.actorOxyUserId,
    reason: params.reason,
    reviewRound: relationship.reviewRound,
    fromStatus: relationship.status,
  });
  if (!review) {
    throw conflict('You have already approved this relationship in its current review round.');
  }
  return review;
}

export interface VerifyRelationshipParams {
  relationshipId: string;
  method: RelationshipVerificationMethod;
  actorOxyUserId: string;
  reason: string;
  /** Close the claim at a known end date as part of the decision (issue field 7). */
  validTo?: Date;
}

/**
 * Verify — the only path to a public badge, and the one with every gate on it.
 *
 * In order: the transition must be admissible, an ACTIVE evidence row of a
 * sufficient kind must exist for this relationship kind, and a badge-producing
 * kind must already carry an endorsement from a DIFFERENT operator. Only then
 * does the CAS run.
 *
 * The evidence gate is where "domain control proves control of that domain"
 * lands: `SUFFICIENT_EVIDENCE_KINDS` does not list `domain_control` for
 * `merchant_official_channel_for_brand`, so an operator holding only a proof of
 * hostname control is refused, with the acceptable kinds named.
 */
export async function verifyRelationship(
  params: VerifyRelationshipParams,
): Promise<CommerceRelationshipRow> {
  if (params.reason.trim() === '') {
    throw validationError('Verifying a relationship requires a reason.');
  }
  const db = getDb();
  const relationship = await findRelationshipById(db, params.relationshipId);
  if (!relationship) throw notFound('Relationship not found');
  if (!canTransition(relationship.status, 'verified')) {
    throw conflict(`A ${relationship.status} relationship cannot be verified.`);
  }

  const evidence = await listEvidence(db, params.relationshipId);
  const sufficient = findSufficientEvidence(relationship.kind, evidence);
  if (sufficient.length === 0) {
    throw forbidden(
      `Verifying a ${relationship.kind} claim needs active evidence of one of: ` +
        `${acceptableEvidenceKinds(relationship.kind).join(', ')}. ` +
        'Control of a domain proves control of that domain and nothing more.',
    );
  }

  if (requiresFourEyes(relationship.kind, config.catalog.fourEyesRequired)) {
    const approvals = await listApprovalsForRound(db, {
      relationshipId: relationship.id,
      reviewRound: relationship.reviewRound,
    });
    const others = approvals.filter((row) => row.actorOxyUserId !== params.actorOxyUserId);
    if (others.length === 0) {
      throw forbidden(
        'This relationship produces a public badge and needs a second operator: another ' +
          'operator must approve it before it can be verified.',
      );
    }
  }

  const now = new Date();
  const verified = await transitionRelationship(db, {
    id: relationship.id,
    expectedStatus: relationship.status,
    toStatus: 'verified',
    verificationMethod: params.method,
    verifiedAt: now,
    verifiedByOxyUserId: params.actorOxyUserId,
    lastCheckedAt: now,
    validTo: params.validTo ?? relationship.validTo ?? undefined,
  });
  if (!verified) {
    throw conflict('The relationship changed while being verified; re-read it and retry.');
  }

  await insertReview(db, {
    relationshipId: relationship.id,
    action: 'approve',
    actorOxyUserId: params.actorOxyUserId,
    reason: params.reason,
    reviewRound: relationship.reviewRound,
    fromStatus: relationship.status,
    toStatus: 'verified',
  });

  log.general.info(
    {
      relationshipId: verified.id,
      kind: verified.kind,
      method: params.method,
      actorOxyUserId: params.actorOxyUserId,
      evidenceKinds: sufficient.map((row) => row.kind),
    },
    '[CommerceGraph] relationship verified',
  );
  return verified;
}

/** Refuse a claim. The row stays, rejected, as the record that it was asked. */
export async function rejectRelationship(params: {
  relationshipId: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<CommerceRelationshipRow> {
  return decide(params, 'reject', 'rejected');
}

/**
 * Ask for more proof. The claim returns to `candidate`, so the queue reflects
 * that the ball is with the asserter — and the round advances, which retires
 * any approval already given for the version that was refused.
 */
export async function requestMoreEvidence(params: {
  relationshipId: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<CommerceRelationshipRow> {
  return decide(params, 'request_more_evidence', 'candidate');
}

/** The shared body of the two decisions above. */
async function decide(
  params: { relationshipId: string; actorOxyUserId: string; reason: string },
  action: 'reject' | 'request_more_evidence',
  toStatus: RelationshipVerificationState,
): Promise<CommerceRelationshipRow> {
  if (params.reason.trim() === '') {
    throw validationError('A review decision requires a reason.');
  }
  const db = getDb();
  const relationship = await findRelationshipById(db, params.relationshipId);
  if (!relationship) throw notFound('Relationship not found');
  if (!canTransition(relationship.status, toStatus)) {
    throw conflict(`A ${relationship.status} relationship cannot move to ${toStatus}.`);
  }

  const changed = await transitionRelationship(db, {
    id: relationship.id,
    expectedStatus: relationship.status,
    toStatus,
    rejectedAt: toStatus === 'rejected' ? new Date() : undefined,
    lastCheckedAt: new Date(),
  });
  if (!changed) {
    throw conflict('The relationship changed while being reviewed; re-read it and retry.');
  }
  await insertReview(db, {
    relationshipId: relationship.id,
    action,
    actorOxyUserId: params.actorOxyUserId,
    reason: params.reason,
    reviewRound: relationship.reviewRound,
    fromStatus: relationship.status,
    toStatus,
  });
  return changed;
}

/**
 * End a verified claim.
 *
 * `expire` is time running out on something that was true; `revoke` is a
 * decision that it should not have stood. Both close the validity window and
 * both KEEP the verification columns — who verified it, how and when survive the
 * ending, which is exactly what "revocation removes current public status
 * without erasing history" means at the row level (acceptance criterion 3).
 */
export async function endRelationship(params: {
  relationshipId: string;
  action: 'expire' | 'revoke';
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<CommerceRelationshipRow> {
  if (params.reason.trim() === '') {
    throw validationError('Ending a relationship requires a reason.');
  }
  const db = getDb();
  const relationship = await findRelationshipById(db, params.relationshipId);
  if (!relationship) throw notFound('Relationship not found');
  const toStatus = params.action === 'expire' ? 'expired' : 'revoked';
  if (!canTransition(relationship.status, toStatus)) {
    throw conflict(`A ${relationship.status} relationship cannot be ${toStatus}.`);
  }

  const at = params.at ?? new Date();
  // `valid_to` must be strictly after `valid_from` (a CHECK); a claim ended in
  // the same millisecond it opened gets the smallest window the column admits
  // rather than a refused write the operator cannot act on.
  const validTo = at.getTime() > relationship.validFrom.getTime()
    ? at
    : new Date(relationship.validFrom.getTime() + 1);

  const ended = await closeRelationship(db, {
    id: relationship.id,
    expectedStatus: relationship.status,
    toStatus,
    validTo,
    expiredAt: params.action === 'expire' ? at : undefined,
    revokedAt: params.action === 'revoke' ? at : undefined,
    revokedByOxyUserId: params.action === 'revoke' ? params.actorOxyUserId : undefined,
    revokeReason: params.action === 'revoke' ? params.reason : undefined,
  });
  if (!ended) {
    throw conflict('The relationship changed while being closed; re-read it and retry.');
  }
  await insertReview(db, {
    relationshipId: relationship.id,
    action: params.action,
    actorOxyUserId: params.actorOxyUserId,
    reason: params.reason,
    reviewRound: relationship.reviewRound,
    fromStatus: relationship.status,
    toStatus,
  });
  log.general.info(
    {
      relationshipId: ended.id,
      kind: ended.kind,
      action: params.action,
      actorOxyUserId: params.actorOxyUserId,
    },
    '[CommerceGraph] relationship closed',
  );
  return ended;
}

export interface CorrectRelationshipParams {
  relationshipId: string;
  actorOxyUserId: string;
  reason: string;
  territories?: string[];
  languages?: string[];
  validFrom?: Date;
  validTo?: Date;
  note?: string;
}

/**
 * The reversible correction path (operator workflow 5).
 *
 * A correction never edits a row into a different meaning: it REVOKES the
 * existing one and opens a NEW claim carrying the corrected scope, linked back
 * through `superseded_by_id`. The pair is the history — what was believed, what
 * replaced it, who decided and why — and the new row starts as a candidate,
 * because a correction is an assertion and verifying it runs every gate again.
 *
 * Both writes commit in ONE transaction: a revoked claim with no successor, or a
 * successor nothing points at, would each be a worse state than either end.
 */
export async function correctRelationship(
  params: CorrectRelationshipParams,
): Promise<{ revoked: CommerceRelationshipRow; replacement: CommerceRelationshipRow }> {
  if (params.reason.trim() === '') {
    throw validationError('A correction requires a reason.');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const original = await findRelationshipById(tx, params.relationshipId);
    if (!original) throw notFound('Relationship not found');
    if (original.supersededById !== null) {
      throw conflict('This relationship has already been corrected.');
    }

    const at = new Date();
    const validTo =
      at.getTime() > original.validFrom.getTime()
        ? at
        : new Date(original.validFrom.getTime() + 1);

    // Three cases, and the third is why this is not one expression: a verified
    // claim is REVOKED (its window closes and its verification survives), a live
    // claim is rejected, and a claim already in a terminal state is left exactly
    // as it is — re-stamping a rejection over an expiry would rewrite the record
    // of how it actually ended, which is the one thing a correction may not do.
    const closed = await closeOriginalForCorrection(tx, original, at, validTo, params);
    if (!closed) {
      throw conflict('The relationship changed while being corrected; re-read it and retry.');
    }

    const replacement = await insertRelationship(tx, {
      kind: original.kind,
      organizationId: original.organizationId ?? undefined,
      brandId: original.brandId ?? undefined,
      merchantId: original.merchantId ?? undefined,
      productFamilyId: original.productFamilyId ?? undefined,
      relatedBrandId: original.relatedBrandId ?? undefined,
      territories: normalizeTerritories(params.territories ?? original.territories),
      languages: normalizeLanguages(params.languages ?? original.languages),
      storefrontId: original.storefrontId ?? undefined,
      validFrom: params.validFrom ?? at,
      validTo: params.validTo,
      status: 'candidate',
      assertedByKind: 'catalog_operator',
      createdByOxyUserId: params.actorOxyUserId,
      note: params.note ?? original.note ?? undefined,
    });
    if (!replacement) {
      throw conflict('A correction for these endpoints is already open.');
    }

    const linked = await markSuperseded(tx, {
      id: original.id,
      supersededById: replacement.id,
    });
    if (!linked) {
      throw conflict('The relationship was corrected concurrently; re-read it and retry.');
    }

    await insertReview(tx, {
      relationshipId: original.id,
      action: 'correct',
      actorOxyUserId: params.actorOxyUserId,
      reason: params.reason,
      reviewRound: original.reviewRound,
      fromStatus: original.status,
      toStatus: closed.status,
    });

    log.general.info(
      {
        relationshipId: original.id,
        replacementId: replacement.id,
        actorOxyUserId: params.actorOxyUserId,
      },
      '[CommerceGraph] relationship corrected',
    );
    return { revoked: closed, replacement };
  });
}

/** The three-way close described at {@link correctRelationship}'s call site. */
async function closeOriginalForCorrection(
  tx: DatabaseOrTransaction,
  original: CommerceRelationshipRow,
  at: Date,
  validTo: Date,
  params: { actorOxyUserId: string; reason: string },
): Promise<CommerceRelationshipRow | undefined> {
  if (original.status === 'verified') {
    return closeRelationship(tx, {
      id: original.id,
      expectedStatus: original.status,
      toStatus: 'revoked',
      validTo,
      revokedAt: at,
      revokedByOxyUserId: params.actorOxyUserId,
      revokeReason: params.reason,
    });
  }
  if (canTransition(original.status, 'rejected')) {
    return transitionRelationship(tx, {
      id: original.id,
      expectedStatus: original.status,
      toStatus: 'rejected',
      rejectedAt: at,
    });
  }
  return original;
}

// ── Operator reads ──────────────────────────────────────────────────────────

/**
 * The candidate queue with its evidence summary, four-eyes tally and conflicts
 * (operator workflow 1 and 4).
 *
 * Conflicts are computed against the rows sharing each candidate's endpoints,
 * which is why the queue fetches per candidate rather than in one pass: a queue
 * that reported only the conflicts visible within its own page would be a queue
 * whose findings depend on the page size.
 */
export async function listCandidateQueue(params: {
  statuses?: readonly RelationshipVerificationState[];
  limit: number;
  offset: number;
}): Promise<RelationshipCandidate[]> {
  const db = getDb();
  const rows = await listRelationshipsByStatus(db, {
    statuses: params.statuses ?? ['candidate', 'pending_review'],
    limit: params.limit,
    offset: params.offset,
  });
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [evidence, approvals] = await Promise.all([
    listEvidenceForRelationships(db, ids),
    listApprovalsForRelationships(db, ids),
  ]);

  const at = new Date();
  return Promise.all(
    rows.map(async (row) => {
      const own = evidence.filter((item) => item.relationshipId === row.id);
      const roundApprovals = approvals.filter(
        (item) => item.relationshipId === row.id && item.reviewRound === row.reviewRound,
      );
      return {
        relationship: toOperatorRelationshipDTO(row, null),
        evidenceCount: own.length,
        activeEvidenceCount: own.filter((item) => item.status === 'active').length,
        evidenceKinds: [...new Set(own.map((item) => item.kind))],
        approvedByOxyUserIds: roundApprovals.map((item) => item.actorOxyUserId),
        requiresFourEyes: requiresFourEyes(row.kind, config.catalog.fourEyesRequired),
        conflicts: await conflictsFor(db, row, at),
      };
    }),
  );
}

/** One relationship with everything an operator needs to decide it. */
export async function getRelationshipForOperator(id: string): Promise<{
  relationship: OperatorCommerceRelationship;
  evidence: RelationshipEvidenceDTO[];
  reviews: RelationshipReviewDTO[];
  conflicts: RelationshipConflict[];
  requiresFourEyes: boolean;
}> {
  const db = getDb();
  const row = await findRelationshipById(db, id);
  if (!row) throw notFound('Relationship not found');
  const [evidence, reviews, predecessor, conflicts] = await Promise.all([
    listEvidence(db, id),
    listReviews(db, id),
    findPredecessor(db, id),
    conflictsFor(db, row, new Date()),
  ]);
  return {
    relationship: toOperatorRelationshipDTO(row, predecessor?.id ?? null),
    evidence: evidence.map(toEvidenceDTO),
    reviews: reviews.map(toReviewDTO),
    conflicts,
    requiresFourEyes: requiresFourEyes(row.kind, config.catalog.fourEyesRequired),
  };
}

/**
 * Conflicts for one row, against every relationship touching ANY of its
 * endpoints.
 *
 * One query per populated endpoint, merged by id — not one query with the
 * endpoints ANDed together, which would find only rows sharing every endpoint
 * and so would miss the two conflicts that matter most: a rival ownership claim
 * (same brand, DIFFERENT organization) and a channel/reseller overlap (same
 * merchant and brand, different kind).
 */
async function conflictsFor(
  db: DatabaseOrTransaction,
  row: CommerceRelationshipRow,
  at: Date,
): Promise<RelationshipConflict[]> {
  const lookups: { brandId?: string; merchantId?: string; organizationId?: string; productFamilyId?: string }[] = [];
  if (row.brandId !== null) lookups.push({ brandId: row.brandId });
  if (row.relatedBrandId !== null) lookups.push({ brandId: row.relatedBrandId });
  if (row.merchantId !== null) lookups.push({ merchantId: row.merchantId });
  if (row.organizationId !== null) lookups.push({ organizationId: row.organizationId });
  if (row.productFamilyId !== null) lookups.push({ productFamilyId: row.productFamilyId });

  const fetched = await Promise.all(
    lookups.map((lookup) => listRelationshipsForEntity(db, lookup)),
  );
  const byId = new Map<string, CommerceRelationshipRow>([[row.id, row]]);
  for (const rows of fetched) {
    for (const related of rows) byId.set(related.id, related);
  }
  const candidates = [...byId.values()].map(toConflictRow);
  const evidence: ConflictEvidenceFact[] = (
    await listEvidenceForRelationships(
      db,
      candidates.map((item) => item.id),
    )
  ).map((item) => ({ relationshipId: item.relationshipId, status: item.status }));

  return detectConflicts({
    subject: toConflictRow(row),
    related: candidates,
    evidence,
    at,
  });
}

/**
 * Whether an explicit trusted rule would let an automated actor verify this
 * combination. Exported because it is the answer #58's matcher and #83's domain
 * mechanism need before writing anything, and because a caller re-deriving it
 * would be a second copy of the one rule that keeps machines out of verdicts.
 */
export function automatedVerificationPermitted(input: {
  kind: RelationshipKind;
  method: RelationshipVerificationMethod;
  assertedBy: RelationshipAssertedByKind;
}): boolean {
  return canAutoVerify(input);
}

/** ISO 3166-1 alpha-2, uppercased and deduplicated — the CHECK rejects the rest. */
function normalizeTerritories(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
}

/** Language subtags, lowercased on the primary subtag and deduplicated. */
function normalizeLanguages(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}
