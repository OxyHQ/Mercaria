/**
 * The operator acquisition surface (#86 §"Operator acquisition pipeline") —
 * THIN handlers behind `ANALYTICS_OPERATOR_OXY_USER_IDS`.
 *
 * Read, plus the eight writes `MERCHANT_ACQUISITION_ACTIONS` names. Every one
 * drives an idempotent path in `acquisition.service.ts` and every one is
 * audited there, refusals included — the handlers add no decision of their own,
 * which is what keeps the audit complete: a refusal decided in a controller
 * would be a refusal the service never saw.
 *
 * There is deliberately no send, no message, no template render and no mail
 * import anywhere on this surface (#86 acquisition 8). The outreach CONTEXT is
 * evidence an operator writes from; the outreach LOG is what they record
 * afterwards.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { MerchantAcquisitionState } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import {
  addContactSource,
  assignCandidate,
  clearExclusion,
  enrolMerchant,
  excludeCandidate,
  listPipeline,
  logOutreach,
  readCandidate,
  rescoreCandidate,
  setDoNotContact,
  setNextAction,
} from '../services/merchant-demand/acquisition.service.js';
import { buildOutreachContext } from '../services/merchant-demand/outreach-context.js';
import {
  readMerchantDemandDashboard,
  readMerchantSnapshotById,
} from '../services/merchant-demand/dashboard.service.js';
import { countCandidatesByState } from '../db/merchantDemand/merchantAcquisitionRepository.js';
import { countMerchantSnapshots } from '../db/merchantDemand/merchantDemandSnapshotRepository.js';
import { metricsAwaitingSeams } from '../services/merchant-demand/metrics.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** GET /internal/merchant-demand/candidates — one page of the pipeline. */
export async function listCandidatesHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      state?: MerchantAcquisitionState;
      assignedTo?: string;
      limit?: number;
      offset?: number;
    };
    const candidates = await listPipeline({
      ...(query.state === undefined ? {} : { states: [query.state] }),
      ...(query.assignedTo === undefined ? {} : { assignedToOxyUserId: query.assignedTo }),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    sendSuccess(res, { candidates });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list acquisition candidates');
  }
}

/** GET /internal/merchant-demand/candidates/:merchantId — one candidate. */
export async function getCandidateHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    // Enrolment is idempotent and is not a decision: reading a merchant that
    // has never been scored should show it with an empty pipeline rather than
    // 404, or the surface can only see merchants somebody already touched.
    await enrolMerchant(merchantId);
    sendSuccess(res, await readCandidate(merchantId));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read the acquisition candidate');
  }
}

/**
 * GET /internal/merchant-demand/candidates/:merchantId/outreach-context
 *
 * The generated, reviewable context. Composed from the snapshot the candidate's
 * score cites when there is one, and from a freshly built one when there is not
 * — so an operator can never be handed a context whose evidence they cannot
 * open.
 */
export async function getOutreachContextHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    await enrolMerchant(merchantId);
    const candidate = await readCandidate(merchantId);
    const view =
      candidate.snapshotId === undefined
        ? await readMerchantDemandDashboard({
            merchantId,
            market: '',
            windowDays: config.merchantDemand.defaultWindowDays,
            refresh: false,
          })
        : await readMerchantSnapshotById({ merchantId, snapshotId: candidate.snapshotId });
    sendSuccess(res, buildOutreachContext(view));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to compose the outreach context');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/rescore. */
export async function rescoreCandidateHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as { market?: string; windowDays?: number };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await rescoreCandidate({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        market: body.market === undefined ? '' : body.market.toUpperCase(),
        windowDays: body.windowDays ?? config.merchantDemand.defaultWindowDays,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to rescore the candidate');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/assign. */
export async function assignCandidateHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as { assignedToOxyUserId: string | null };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await assignCandidate({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        assignedToOxyUserId: body.assignedToOxyUserId,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to assign the candidate');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/next-action. */
export async function setNextActionHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as {
      state: MerchantAcquisitionState;
      nextAction: string | null;
      nextActionDueAt: string | null;
    };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await setNextAction({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        state: body.state,
        nextAction: body.nextAction,
        nextActionDueAt: body.nextActionDueAt === null ? null : new Date(body.nextActionDueAt),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to set the next action');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/exclude. */
export async function excludeCandidateHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as { reason: Parameters<typeof excludeCandidate>[0]['reason'] };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await excludeCandidate({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to exclude the candidate');
  }
}

/** DELETE /internal/merchant-demand/candidates/:merchantId/exclude. */
export async function clearExclusionHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    sendSuccess(
      res,
      await clearExclusion({ merchantId, actorOxyUserId: getRequiredOxyUserId(req) }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to clear the exclusion');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/do-not-contact. */
export async function setDoNotContactHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as { doNotContact: boolean };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await setDoNotContact({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        doNotContact: body.doNotContact,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record the do-not-contact state');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/contact-sources. */
export async function addContactSourceHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as {
      kind: Parameters<typeof addContactSource>[0]['kind'];
      sourceUrl: string;
      locatorNote: string;
      observedAt: string;
    };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await addContactSource({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        kind: body.kind,
        sourceUrl: body.sourceUrl,
        locatorNote: body.locatorNote,
        observedAt: new Date(body.observedAt),
      }),
      201,
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record the contact source');
  }
}

/** POST /internal/merchant-demand/candidates/:merchantId/outreach. */
export async function recordOutreachHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    const body = req.body as {
      channel: Parameters<typeof logOutreach>[0]['channel'];
      outcome: Parameters<typeof logOutreach>[0]['outcome'];
      occurredAt: string;
      contactSourceId?: string;
    };
    await enrolMerchant(merchantId);
    sendSuccess(
      res,
      await logOutreach({
        merchantId,
        actorOxyUserId: getRequiredOxyUserId(req),
        channel: body.channel,
        outcome: body.outcome,
        occurredAt: new Date(body.occurredAt),
        ...(body.contactSourceId === undefined ? {} : { contactSourceId: body.contactSourceId }),
      }),
      201,
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record the outreach attempt');
  }
}

/**
 * GET /internal/merchant-demand/health.
 *
 * The two numbers that say whether this domain is telling the truth: which
 * metrics are waiting on a seam (so a dashboard can label them rather than
 * render a zero) and how the pipeline is distributed. Snapshot counts per
 * merchant are on the candidate read; a global one would be a table scan for a
 * number nobody acts on.
 */
export async function acquisitionHealthHandler(_req: Request, res: Response): Promise<void> {
  try {
    const byState = await countCandidatesByState();
    sendSuccess(res, {
      pipeline: Object.fromEntries(byState),
      metricsAwaitingSeams: metricsAwaitingSeams(),
      merchantDemand: {
        dashboardEnabled: config.merchantDemand.dashboardEnabled,
        previewEnabled: config.merchantDemand.previewEnabled,
        collectionMode: config.analytics.collectionMode,
      },
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read acquisition health');
  }
}

/** GET /internal/merchant-demand/candidates/:merchantId/snapshots — the count. */
export async function candidateSnapshotsHandler(req: Request, res: Response): Promise<void> {
  try {
    const merchantId = routeParam(req, 'merchantId');
    sendSuccess(res, await countMerchantSnapshots(merchantId));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to count the merchant snapshots');
  }
}
