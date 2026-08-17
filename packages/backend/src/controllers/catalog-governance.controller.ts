/**
 * The catalog governance operator surface (#367 Workstream 12).
 *
 * Thin handlers. Every one resolves the actor's roles, mints a
 * `CatalogGovernanceActor` and hands it to a service — which is the ONLY way
 * one is obtained, and therefore the reason "a merchant role may never publish
 * a global catalog change" is a property of the call graph rather than a check
 * anybody here performs.
 *
 * The role resolution is one read per request and is deliberately not cached:
 * a revoked capability that takes effect on the next request is the behaviour
 * an incident needs, and a memo would make "I revoked their publish" mean "in
 * up to N seconds".
 */

import type { Request, Response } from 'express';
import type {
  CatalogGovernanceChangeState,
  CatalogGovernanceDomain,
  CatalogGovernanceSnapshotScope,
  CatalogGovernanceSubjectKind,
} from '@mercaria/shared-types';
import { respondWithError } from '../lib/errors/index.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { getDb } from '../db/postgres.js';
import { listAuditEvents } from '../db/catalogGovernance/auditRepository.js';
import { governanceActor, type CatalogGovernanceActor } from '../services/catalog-governance/actor.js';
import {
  applyChangeRequest,
  approveChangeRequest,
  planChange,
  readChangeRequest,
  readChangeRequestQueue,
  rejectChangeRequest,
  withdrawChangeRequest,
} from '../services/catalog-governance/change-request.service.js';
import { measureImpact } from '../services/catalog-governance/impact.service.js';
import {
  grantRole,
  listRoleGrants,
  resolveGovernanceRoles,
  revokeRole,
} from '../services/catalog-governance/role.service.js';
import {
  readGovernanceQueues,
  scanOrphanedReferences,
} from '../services/catalog-governance/queue.service.js';
import { readCatalogQuality } from '../services/catalog-governance/quality.service.js';
import {
  promoteCompatibilityClaimToFitment,
  readCompatibilityClaimQueue,
  type CompatibilityClaimQueueQuery,
  type PromoteCompatibilityClaimInput,
} from '../services/catalog-governance/compatibility-claim.service.js';
import {
  exportDefinitions,
  readSnapshotDocument,
  readSnapshots,
  restoreDefinitions,
} from '../services/catalog-governance/snapshot.service.js';
import {
  listVerticalPackages,
  readVerticalPackageCensus,
  runVerticalPackage,
} from '../services/catalog-governance/vertical-package.service.js';
import {
  reviewCompatibilityClaim,
  reviewExternalMapping,
  reviewLocalization,
} from '../services/catalog-governance/review.service.js';
import { composeDefinitionDiff } from '../services/catalog-governance/definition-diff.service.js';

/**
 * Resolve the caller's capability set and mint the actor.
 *
 * `governanceActor` composes `catalogOperatorId`, which throws when the request
 * carries no verified Oxy id — so there is no branch here that could produce an
 * unauthenticated actor.
 */
async function actorFor(req: Request): Promise<CatalogGovernanceActor> {
  const resolution = await resolveGovernanceRoles(
    // Read through the same helper the actor mints from, so the id the roles
    // were resolved for and the id the actor carries cannot differ.
    governanceActor(req, []).oxyUserId,
    getDb(),
  );
  return governanceActor(req, resolution.roles);
}

/** GET /internal/catalog-governance/me — what may I do here. */
export async function governanceCapabilitiesHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = governanceActor(req, []).oxyUserId;
    const resolution = await resolveGovernanceRoles(oxyUserId, getDb());
    sendSuccess(res, {
      oxyUserId,
      mode: resolution.mode,
      roles: resolution.roles,
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to resolve governance capabilities');
  }
}

/** GET /internal/catalog-governance/impact */
export async function governanceImpactHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      subjectKind: CatalogGovernanceSubjectKind;
      subjectId: string;
    };
    sendSuccess(res, await measureImpact(query.subjectKind, query.subjectId, getDb()));
  } catch (error) {
    respondWithError(res, error, 'Failed to measure impact');
  }
}

/** POST /internal/catalog-governance/changes */
export async function planChangeHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Parameters<typeof planChange>[2];
    sendSuccess(res, await planChange(getDb(), await actorFor(req), body), 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to plan the change');
  }
}

/** GET /internal/catalog-governance/changes */
export async function changeQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      state?: CatalogGovernanceChangeState;
      domain?: CatalogGovernanceDomain;
      subjectKind?: CatalogGovernanceSubjectKind;
      subjectId?: string;
      limit: number;
      offset: number;
    };
    sendSuccess(
      res,
      await readChangeRequestQueue(getDb(), {
        states: query.state ? [query.state] : undefined,
        domains: query.domain ? [query.domain] : undefined,
        subjectKind: query.subjectKind,
        subjectId: query.subjectId,
        limit: query.limit,
        offset: query.offset,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to read the change queue');
  }
}

/** GET /internal/catalog-governance/changes/:changeId */
export async function changeTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readChangeRequest(getDb(), routeParam(req, 'changeId')));
  } catch (error) {
    respondWithError(res, error, 'Failed to read the change request');
  }
}

/** POST /internal/catalog-governance/changes/:changeId/approve */
export async function approveChangeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { reason } = req.body as { reason: string };
    sendSuccess(
      res,
      await approveChangeRequest(getDb(), await actorFor(req), routeParam(req, 'changeId'), reason),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to approve the change request');
  }
}

/** POST /internal/catalog-governance/changes/:changeId/apply */
export async function applyChangeHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await applyChangeRequest(getDb(), await actorFor(req), routeParam(req, 'changeId')),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to apply the change request');
  }
}

/** POST /internal/catalog-governance/changes/:changeId/reject */
export async function rejectChangeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { reason } = req.body as { reason: string };
    sendSuccess(
      res,
      await rejectChangeRequest(getDb(), await actorFor(req), routeParam(req, 'changeId'), reason),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to reject the change request');
  }
}

/** POST /internal/catalog-governance/changes/:changeId/withdraw */
export async function withdrawChangeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { reason } = req.body as { reason: string };
    sendSuccess(
      res,
      await withdrawChangeRequest(getDb(), await actorFor(req), routeParam(req, 'changeId'), reason),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to withdraw the change request');
  }
}

/** GET /internal/catalog-governance/diff/product-types/:key */
export async function productTypeDiffHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as { fromVersion: number; toVersion: number };
    sendSuccess(
      res,
      await composeDefinitionDiff(getDb(), {
        subjectKind: 'product_type_definition',
        key: routeParam(req, 'key'),
        fromVersion: query.fromVersion,
        toVersion: query.toVersion,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to diff the product type versions');
  }
}

/** GET /internal/catalog-governance/diff/attributes/:key */
export async function attributeDiffHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as { fromVersion: number; toVersion: number };
    sendSuccess(
      res,
      await composeDefinitionDiff(getDb(), {
        subjectKind: 'attribute_definition',
        key: routeParam(req, 'key'),
        fromVersion: query.fromVersion,
        toVersion: query.toVersion,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to diff the attribute versions');
  }
}

/** GET /internal/catalog-governance/audit */
export async function auditHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      subjectKind?: CatalogGovernanceSubjectKind;
      subjectId?: string;
      domain?: CatalogGovernanceDomain;
      actorOxyUserId?: string;
      changeRequestId?: string;
      limit: number;
      offset: number;
    };
    sendSuccess(
      res,
      await listAuditEvents(getDb(), {
        subjectKind: query.subjectKind,
        subjectId: query.subjectId,
        domains: query.domain ? [query.domain] : undefined,
        actorOxyUserId: query.actorOxyUserId,
        changeRequestId: query.changeRequestId,
        limit: query.limit,
        offset: query.offset,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to read the audit trail');
  }
}

/** GET /internal/catalog-governance/queues */
export async function queuesHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readGovernanceQueues(getDb()));
  } catch (error) {
    respondWithError(res, error, 'Failed to read the review queues');
  }
}

/** GET /internal/catalog-governance/quality */
export async function qualityHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readCatalogQuality(getDb()));
  } catch (error) {
    respondWithError(res, error, 'Failed to read catalogue quality');
  }
}

/** GET /internal/catalog-governance/quality/orphans */
export async function orphanHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    sendSuccess(res, await scanOrphanedReferences(getDb(), limit));
  } catch (error) {
    respondWithError(res, error, 'Failed to scan for orphaned references');
  }
}

/** GET /internal/catalog-governance/roles */
export async function roleListHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    sendSuccess(res, await listRoleGrants(getDb(), limit, offset));
  } catch (error) {
    respondWithError(res, error, 'Failed to read role grants');
  }
}

/** POST /internal/catalog-governance/roles */
export async function grantRoleHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Parameters<typeof grantRole>[2];
    sendSuccess(res, await grantRole(getDb(), await actorFor(req), body), 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to grant the role');
  }
}

/** POST /internal/catalog-governance/roles/revoke */
export async function revokeRoleHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Parameters<typeof revokeRole>[2];
    sendSuccess(res, await revokeRole(getDb(), await actorFor(req), body));
  } catch (error) {
    respondWithError(res, error, 'Failed to revoke the role');
  }
}

/** GET /internal/catalog-governance/snapshots */
export async function snapshotListHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    sendSuccess(res, await readSnapshots(getDb(), limit, offset));
  } catch (error) {
    respondWithError(res, error, 'Failed to read definition snapshots');
  }
}

/** POST /internal/catalog-governance/snapshots */
export async function exportSnapshotHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { scope: CatalogGovernanceSnapshotScope; reason: string };
    sendSuccess(res, await exportDefinitions(getDb(), await actorFor(req), body), 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to export definitions');
  }
}

/** GET /internal/catalog-governance/snapshots/:snapshotId */
export async function snapshotDocumentHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readSnapshotDocument(getDb(), routeParam(req, 'snapshotId')));
  } catch (error) {
    respondWithError(res, error, 'Failed to read the definition snapshot');
  }
}

/** POST /internal/catalog-governance/snapshots/:snapshotId/restore */
export async function restoreSnapshotHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { apply: boolean; reason: string };
    sendSuccess(
      res,
      await restoreDefinitions(getDb(), await actorFor(req), {
        snapshotId: routeParam(req, 'snapshotId'),
        apply: body.apply,
        reason: body.reason,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to restore definitions');
  }
}

/** GET /internal/catalog-governance/vertical-packages */
export async function verticalPackageListHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, listVerticalPackages());
  } catch (error) {
    respondWithError(res, error, 'Failed to list vertical packages');
  }
}

/** POST /internal/catalog-governance/vertical-packages/:packageName */
export async function verticalPackageHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { namespace?: string; apply: boolean; reason: string };
    sendSuccess(
      res,
      await runVerticalPackage(getDb(), await actorFor(req), {
        packageName: routeParam(req, 'packageName'),
        namespace: body.namespace,
        apply: body.apply,
        reason: body.reason,
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to run the vertical package');
  }
}

/** GET /internal/catalog-governance/vertical-packages/:packageName/census */
export async function verticalPackageCensusHandler(req: Request, res: Response): Promise<void> {
  try {
    const { namespace } = req.query as unknown as { namespace: string };
    sendSuccess(res, {
      verdict: await readVerticalPackageCensus(routeParam(req, 'packageName'), namespace, getDb()),
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to run the vertical package census');
  }
}

/** POST /internal/catalog-governance/reviews/localization */
export async function reviewLocalizationHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Parameters<typeof reviewLocalization>[2];
    await reviewLocalization(getDb(), await actorFor(req), body);
    sendSuccess(res, { reviewed: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to review the translation');
  }
}

/** POST /internal/catalog-governance/reviews/external-mappings/:mappingId */
export async function reviewExternalMappingHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { decision: 'approve' | 'reject' | 'fan_out_approve'; reason: string };
    await reviewExternalMapping(getDb(), await actorFor(req), {
      mappingId: routeParam(req, 'mappingId'),
      decision: body.decision,
      reason: body.reason,
    });
    sendSuccess(res, { reviewed: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to review the external mapping');
  }
}

/** POST /internal/catalog-governance/reviews/compatibility-claims/:claimId */
export async function reviewCompatibilityClaimHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Omit<
      Parameters<typeof reviewCompatibilityClaim>[2],
      'claimId'
    >;
    await reviewCompatibilityClaim(getDb(), await actorFor(req), {
      claimId: routeParam(req, 'claimId'),
      state: body.state,
      reviewNote: body.reviewNote,
      reason: body.reason,
    });
    sendSuccess(res, { reviewed: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to review the compatibility claim');
  }
}

/**
 * GET /internal/catalog-governance/reviews/compatibility-claims
 *
 * The queue the `unresolved_compatibility_claim` count on `GET /queues` was
 * counting. Before this, that number was the only thing an operator could learn
 * about the backlog — there was no read that said WHICH claims.
 */
export async function compatibilityClaimQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as CompatibilityClaimQueueQuery;
    sendSuccess(
      res,
      await readCompatibilityClaimQueue(getDb(), await actorFor(req), {
        ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    );
  } catch (error) {
    respondWithError(res, error, 'Failed to read the compatibility claim queue');
  }
}

/**
 * POST /internal/catalog-governance/reviews/compatibility-claims/:claimId/fitment
 *
 * The vehicle arrives from the OPERATOR, in full, or the request is refused. This
 * handler resolves no candidate and reads no raw text — see
 * `compatibility-claim.service.ts`'s header for the four mechanisms that keep it
 * that way.
 */
export async function promoteCompatibilityClaimHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as Omit<PromoteCompatibilityClaimInput, 'claimId'>;
    const fitment = await promoteCompatibilityClaimToFitment(getDb(), await actorFor(req), {
      ...body,
      claimId: routeParam(req, 'claimId'),
    });
    // The fitment id, so the operator can read the row they just published — and
    // nothing else off it. The full fitment is a public projection's job.
    sendSuccess(res, { promoted: true, fitmentId: fitment.id });
  } catch (error) {
    respondWithError(res, error, 'Failed to promote the compatibility claim');
  }
}
