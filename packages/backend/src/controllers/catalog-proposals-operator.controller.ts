/**
 * The operator review surface (#367 step 6, ADR 0007 D9).
 *
 * Behind `requireCatalogOperator` — the SAME `CATALOG_OPERATOR_OXY_USER_IDS`
 * allow-list #54/#55/#56/#57/#58/#59/#60/#62/#68/#70/#78/#79/#80/#83/#90/#94 use
 * and NOT a seventh list. A proposal asks for a category, a brand, a product type
 * or a controlled value: who may reshape that catalogue and who may decide a
 * request to reshape it are the same power over the same graph, and a separate
 * list would grant whichever half the operator was not vetted for.
 *
 * ## The actor is the VERIFIED caller and never a body field
 *
 * `catalogOperatorId(req)` reads what `authenticateToken` verified. Every
 * decision stamps it as `decided_by_oxy_user_id`, and
 * `catalog_proposals_decider_distinct_check` refuses a decision by the account
 * that submitted the request — so the one thing an operator cannot do here is
 * approve their own proposal.
 */

import type { Request, Response } from 'express';
import type {
  CatalogProposalRejectionReason,
  CatalogProposalState,
  CatalogProposalType,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { listProposals } from '../db/catalogProposals/proposalRepository.js';
import { projectProposals } from '../services/catalog-proposals/publication.js';
import { readProposalTrace } from '../services/catalog-proposals/proposal.service.js';
import { runProposalBackfill } from '../services/catalog-proposals/backfill.service.js';
import {
  approveProposal,
  deferProposal,
  mergeProposalIntoExisting,
  redirectProposal,
  rejectProposal,
  requestProposalInformation,
} from '../services/catalog-proposals/review.service.js';
import { config } from '../config/index.js';

/** `GET /internal/catalog-proposals` — the review queue. */
export async function catalogProposalQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      state?: CatalogProposalState;
      type?: CatalogProposalType;
      storeId?: string;
      limit?: number;
      offset?: number;
    };
    const rows = await listProposals(getDb(), {
      ...(query.state === undefined ? {} : { states: [query.state] }),
      ...(query.type === undefined ? {} : { types: [query.type] }),
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      limit: Math.min(query.limit ?? config.catalogProposals.pageSize, config.catalogProposals.pageSize),
      offset: query.offset ?? 0,
    });
    sendSuccess(res, await projectProposals(getDb(), rows));
  } catch (err) {
    respondWithError(res, err, 'Failed to read the proposal queue');
  }
}

/**
 * `GET /internal/catalog-proposals/:proposalId` — the trace.
 *
 * Opens from a PROPOSAL id and nothing else. There is no route here keyed on a
 * store, a merchant or an account, so "what has this merchant been asking for"
 * is a question the surface cannot be asked in one call — the `/internal/offers`
 * and `/internal/price-alerts` posture.
 */
export async function catalogProposalTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    const trace = await readProposalTrace(getDb(), routeParam(req, 'proposalId'));
    sendSuccess(res, trace);
  } catch (err) {
    respondWithError(res, err, 'Failed to trace the proposal');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/approve`. */
export async function approveCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      key: string;
      label?: string;
      recordSubmittedSpellingAsAlias?: boolean;
      reason: string;
    };
    const proposal = await approveProposal(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      {
        key: body.key,
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.recordSubmittedSpellingAsAlias === undefined
          ? {}
          : { recordSubmittedSpellingAsAlias: body.recordSubmittedSpellingAsAlias }),
        reason: body.reason,
      },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to approve the proposal');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/merge` — link an existing entity. */
export async function mergeCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { resolvedEntityId: string; reason: string };
    const proposal = await mergeProposalIntoExisting(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      { resolvedEntityId: body.resolvedEntityId, reason: body.reason },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to merge the proposal');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/reject`. */
export async function rejectCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { rejectionReason: CatalogProposalRejectionReason; reason: string };
    const proposal = await rejectProposal(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      { rejectionReason: body.rejectionReason, reason: body.reason },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to reject the proposal');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/request-information`. */
export async function requestCatalogProposalInformationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const proposal = await requestProposalInformation(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      { reason: body.reason },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to request information');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/defer`. */
export async function deferCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { until: string; reason: string };
    const until = new Date(body.until);
    if (Number.isNaN(until.getTime())) throw validationError('`until` is an ISO 8601 instant.');
    const proposal = await deferProposal(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      { until, reason: body.reason },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to defer the proposal');
  }
}

/** `POST /internal/catalog-proposals/:proposalId/redirect` — to a different type. */
export async function redirectCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      toType: CatalogProposalType;
      attributeDefinitionId?: string;
      attributeDefinitionVersion?: number;
      reason: string;
    };
    const proposal = await redirectProposal(
      getDb(),
      { proposalId: routeParam(req, 'proposalId'), operatorOxyUserId: catalogOperatorId(req) },
      {
        toType: body.toType,
        ...(body.attributeDefinitionId === undefined
          ? {}
          : { attributeDefinitionId: body.attributeDefinitionId }),
        ...(body.attributeDefinitionVersion === undefined
          ? {}
          : { attributeDefinitionVersion: body.attributeDefinitionVersion }),
        reason: body.reason,
      },
    );
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to redirect the proposal');
  }
}

/**
 * `POST /internal/catalog-proposals/:proposalId/backfill` — re-run one page.
 *
 * The ONE write on this surface that decides nothing, and it drives the SAME
 * idempotent path an approval runs: every reference is claimed by a
 * compare-and-swap on `backfilled_at IS NULL`, so pressing it twice applies
 * nothing the second time and says so. It exists because the approval's own
 * backfill is best-effort — a failed backfill must never un-approve a decision an
 * operator made — and this is how the remainder is picked up.
 */
export async function backfillCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { pageSize?: number };
    const result = await runProposalBackfill(getDb(), {
      proposalId: routeParam(req, 'proposalId'),
      operatorOxyUserId: catalogOperatorId(req),
      ...(body.pageSize === undefined ? {} : { pageSize: body.pageSize }),
    });
    sendSuccess(res, result);
  } catch (err) {
    respondWithError(res, err, 'Failed to run the backfill');
  }
}
