/**
 * The operator half of the relationship surface (#55), under
 * `/internal/commerce-graph/relationships`.
 *
 * Every handler stamps the authenticated operator as the ACTOR — read from the
 * verified caller through `catalogOperatorId`, never from the body, so no
 * request can attribute a decision to someone else. That matters more here than
 * on most surfaces: `relationship_reviews` is append-only and its actor column
 * is the four-eyes mechanism, so a forgeable actor would be a forgeable second
 * approval.
 */

import type { Request, Response } from 'express';
import type {
  RelationshipEvidenceKind,
  RelationshipKind,
  RelationshipVerificationMethod,
  RelationshipVerificationState,
} from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  assertRelationship,
  attachEvidence,
  correctRelationship,
  endRelationship,
  endorseRelationship,
  getRelationshipForOperator,
  listCandidateQueue,
  rejectRelationship,
  requestMoreEvidence,
  revokeRelationshipEvidence,
  toEvidenceDTO,
  toOperatorRelationshipDTO,
  toReviewDTO,
  verifyRelationship,
} from '../services/commerce-graph/relationship.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { config } from '../config/index.js';

/** An optional ISO-8601 string from a validated body, as a `Date`. */
function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

/** POST /internal/commerce-graph/relationships — record a claim, never a verdict. */
export async function assertRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      kind: RelationshipKind;
      organizationId?: string;
      brandId?: string;
      merchantId?: string;
      productFamilyId?: string;
      relatedBrandId?: string;
      storefrontId?: string;
      territories?: string[];
      languages?: string[];
      validFrom?: string;
      validTo?: string;
      note?: string;
    };
    const row = await assertRelationship({
      kind: body.kind,
      organizationId: body.organizationId,
      brandId: body.brandId,
      merchantId: body.merchantId,
      productFamilyId: body.productFamilyId,
      relatedBrandId: body.relatedBrandId,
      storefrontId: body.storefrontId,
      territories: body.territories,
      languages: body.languages,
      validFrom: optionalDate(body.validFrom),
      validTo: optionalDate(body.validTo),
      note: body.note,
      // An operator asserting is still only asserting: the row lands as a
      // candidate and reaching `verified` runs every gate, including four eyes.
      assertedByKind: 'catalog_operator',
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null), 201);
  } catch (error) {
    respondWithError(res, error, 'Recording the relationship claim failed');
  }
}

/** GET /internal/commerce-graph/relationships — the candidate queue. */
export async function listRelationshipQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      status?: RelationshipVerificationState | RelationshipVerificationState[];
      limit?: number;
      offset?: number;
    };
    const statuses =
      query.status === undefined
        ? undefined
        : Array.isArray(query.status)
          ? query.status
          : [query.status];
    const queue = await listCandidateQueue({
      statuses,
      limit: query.limit ?? config.pagination.defaultPageSize,
      offset: query.offset ?? 0,
    });
    sendSuccess(res, queue);
  } catch (error) {
    respondWithError(res, error, 'Reading the relationship queue failed');
  }
}

/** GET /internal/commerce-graph/relationships/:id — the whole file on one claim. */
export async function getRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getRelationshipForOperator(routeParam(req, 'id')));
  } catch (error) {
    respondWithError(res, error, 'Reading the relationship failed');
  }
}

/** POST /internal/commerce-graph/relationships/:id/evidence. */
export async function attachEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      kind: RelationshipEvidenceKind;
      observedFact: string;
      subjectDomain?: string;
      sourceUrl?: string;
      oxyFileId?: string;
      contentSha256?: string;
      sourceRecordId?: string;
      locale?: string;
      observedAt?: string;
      reviewerNote?: string;
      expiresAt?: string;
    };
    const row = await attachEvidence({
      relationshipId: routeParam(req, 'id'),
      kind: body.kind,
      observedFact: body.observedFact,
      subjectDomain: body.subjectDomain,
      sourceUrl: body.sourceUrl,
      oxyFileId: body.oxyFileId,
      contentSha256: body.contentSha256,
      sourceRecordId: body.sourceRecordId,
      locale: body.locale,
      observedAt: optionalDate(body.observedAt),
      reviewerNote: body.reviewerNote,
      expiresAt: optionalDate(body.expiresAt),
      collectedByOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toEvidenceDTO(row), 201);
  } catch (error) {
    respondWithError(res, error, 'Attaching the evidence failed');
  }
}

/** POST /internal/commerce-graph/relationships/:id/evidence/:evidenceId/revoke. */
export async function revokeEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const row = await revokeRelationshipEvidence({
      evidenceId: routeParam(req, 'evidenceId'),
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toEvidenceDTO(row));
  } catch (error) {
    respondWithError(res, error, 'Revoking the evidence failed');
  }
}

/** POST …/relationships/:id/approve — one operator's endorsement (four eyes). */
export async function approveRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const review = await endorseRelationship({
      relationshipId: routeParam(req, 'id'),
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toReviewDTO(review), 201);
  } catch (error) {
    respondWithError(res, error, 'Recording the approval failed');
  }
}

/** POST …/relationships/:id/verify — the only path to a public badge. */
export async function verifyRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      method: RelationshipVerificationMethod;
      reason: string;
      validTo?: string;
    };
    const row = await verifyRelationship({
      relationshipId: routeParam(req, 'id'),
      method: body.method,
      reason: body.reason,
      validTo: optionalDate(body.validTo),
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null));
  } catch (error) {
    respondWithError(res, error, 'Verifying the relationship failed');
  }
}

/** POST …/relationships/:id/reject. */
export async function rejectRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const row = await rejectRelationship({
      relationshipId: routeParam(req, 'id'),
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null));
  } catch (error) {
    respondWithError(res, error, 'Rejecting the relationship failed');
  }
}

/** POST …/relationships/:id/request-evidence. */
export async function requestEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const row = await requestMoreEvidence({
      relationshipId: routeParam(req, 'id'),
      reason: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null));
  } catch (error) {
    respondWithError(res, error, 'Requesting more evidence failed');
  }
}

/** POST …/relationships/:id/expire — time ran out on something that was true. */
export async function expireRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string; at?: string };
    const row = await endRelationship({
      relationshipId: routeParam(req, 'id'),
      action: 'expire',
      reason: body.reason,
      at: optionalDate(body.at),
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null));
  } catch (error) {
    respondWithError(res, error, 'Expiring the relationship failed');
  }
}

/** POST …/relationships/:id/revoke — a decision that it should not stand. */
export async function revokeRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string; at?: string };
    const row = await endRelationship({
      relationshipId: routeParam(req, 'id'),
      action: 'revoke',
      reason: body.reason,
      at: optionalDate(body.at),
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, toOperatorRelationshipDTO(row, null));
  } catch (error) {
    respondWithError(res, error, 'Revoking the relationship failed');
  }
}

/** POST …/relationships/:id/correct — close this row, open its successor. */
export async function correctRelationshipHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      reason: string;
      territories?: string[];
      languages?: string[];
      validFrom?: string;
      validTo?: string;
      note?: string;
    };
    const { revoked, replacement } = await correctRelationship({
      relationshipId: routeParam(req, 'id'),
      reason: body.reason,
      territories: body.territories,
      languages: body.languages,
      validFrom: optionalDate(body.validFrom),
      validTo: optionalDate(body.validTo),
      note: body.note,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(
      res,
      {
        corrected: toOperatorRelationshipDTO(revoked, null),
        replacement: toOperatorRelationshipDTO(replacement, revoked.id),
      },
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Correcting the relationship failed');
  }
}
