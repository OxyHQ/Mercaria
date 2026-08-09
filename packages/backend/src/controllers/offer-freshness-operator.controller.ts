/**
 * The offer-freshness operator surface (#68 §"Source health", anomaly 4).
 *
 * Read a source's catalogue health, publish its freshness policy, look at its
 * refresh queue, release a quarantined run's output, ask for one object to be
 * re-read, and drive one dispatcher tick. Every WRITE drives a path that
 * already exists and is already idempotent, so this surface adds buttons and no
 * second way for a refresh to happen.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No "set this offer's freshness".** The verdict is DERIVED from the
 *   source's contract against the clock; a route that stored one would create
 *   the second representation the whole domain exists to avoid, and it would do
 *   it at the one place an operator is most tempted to use it — during an
 *   incident, on an offer a customer complained about.
 * - **No "retire this offer" and no "un-retire this offer".** #57's operator
 *   surface already owns retirement, with its own reason and its own audit.
 *   Two surfaces retiring offers is two vocabularies for one act.
 * - **No "clear this source's baseline".** The baseline is what a suspicious
 *   run is judged against, so a button that reset it is a button that makes a
 *   broken feed look normal — which is the exact failure the quarantine exists
 *   to catch. A corrected run replaces it, on the record.
 * - **No delete, anywhere.** A quarantine finding, a policy version and a
 *   refresh task are all evidence. Resolution ADDS a verdict beside the finding.
 * - **No flag write.** `OFFER_REFRESH_ENABLED` is read at boot, and a route
 *   that changed it at runtime would make "what was this deployment doing at
 *   14:00" unanswerable from configuration.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CatalogRefreshMode } from '@mercaria/shared-types';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import {
  listFreshnessPolicies,
  publishFreshnessPolicy,
} from '../db/offerFreshness/freshnessPolicyRepository.js';
import {
  listOpenRunQuarantines,
  releaseRunQuarantine,
} from '../db/offerFreshness/runQuarantineRepository.js';
import { listRefreshTasks } from '../db/offerFreshness/refreshTaskRepository.js';
import { readSourceRefreshQuota } from '../db/offerFreshness/refreshLeaseRepository.js';
import { readSourceCatalogHealth } from '../services/offer-freshness/health.service.js';
import { drainOfferRefresh } from '../services/offer-freshness/refresh-dispatcher.js';
import { sweepExpiredOffers } from '../services/offer-freshness/expiry-sweep.js';
import {
  requestPriorityRefresh,
  scheduleSourceRefresh,
} from '../services/offer-freshness/refresh-scheduler.js';
import { publishFreshnessPolicySchema, requestRefreshSchema } from '../middleware/offer-freshness-schemas.js';

/** GET — one source's catalogue health, everything #68 §"Source health" lists. */
export async function sourceCatalogHealthHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const health = await readSourceCatalogHealth({ sourceId });
    if (health === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Source is not configured for ingestion', 404);
      return;
    }
    const quota = await readSourceRefreshQuota({ sourceId });
    sendSuccess(res, { health, quota });
  } catch (err) {
    respondWithError(res, err, 'Failed to read source catalogue health');
  }
}

/** GET — every freshness version this source has ever had. The audit read. */
export async function listFreshnessPoliciesHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const versions = await listFreshnessPolicies(getDb(), sourceId);
    sendSuccess(res, {
      versions: versions.map((version) => ({
        version: version.version,
        status: version.status,
        expectedRefreshIntervalSeconds: version.expectedRefreshIntervalSeconds,
        warningAfterSeconds: version.warningAfterSeconds,
        expiryAfterSeconds: version.expiryAfterSeconds,
        outageGraceSeconds: version.outageGraceSeconds,
        retireOnSourceUnavailable: version.retireOnSourceUnavailable,
        permittedRefreshModes: version.permittedRefreshModes,
        anomalyMinimumSampleSize: version.anomalyMinimumSampleSize,
        anomalyZeroPriceShareBps: version.anomalyZeroPriceShareBps,
        anomalyPriceScaleFactor: version.anomalyPriceScaleFactor,
        anomalyDisappearanceShareBps: version.anomalyDisappearanceShareBps,
        reviewedAt: version.reviewedAt?.toISOString() ?? null,
        reviewedByOxyUserId: version.reviewedByOxyUserId,
        activatedAt: version.activatedAt?.toISOString() ?? null,
        supersededAt: version.supersededAt?.toISOString() ?? null,
        supersedesVersion: version.supersedesVersion,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list freshness policy versions');
  }
}

/** POST — publish and activate a freshness version, superseding the last. */
export async function publishFreshnessPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const parsed = publishFreshnessPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const body = parsed.data;
    const published = await publishFreshnessPolicy(getDb(), {
      sourceId,
      expectedRefreshIntervalSeconds: body.expectedRefreshIntervalSeconds,
      warningAfterSeconds: body.warningAfterSeconds,
      expiryAfterSeconds: body.expiryAfterSeconds,
      outageGraceSeconds: body.outageGraceSeconds,
      retireOnSourceUnavailable: body.retireOnSourceUnavailable,
      permittedRefreshModes: (body.permittedRefreshModes ?? []) as readonly CatalogRefreshMode[],
      anomalyMinimumSampleSize: body.anomalyMinimumSampleSize,
      anomalyZeroPriceShareBps: body.anomalyZeroPriceShareBps,
      anomalyPriceScaleFactor: body.anomalyPriceScaleFactor,
      anomalyDisappearanceShareBps: body.anomalyDisappearanceShareBps,
      reviewNote: body.reviewNote ?? null,
      reviewedByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });
    sendSuccess(res, { version: published.version, status: published.status }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to publish a freshness policy version');
  }
}

/** GET — this source's refresh queue, most urgent first. */
export async function listRefreshTasksHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const tasks = await listRefreshTasks(getDb(), { sourceId, limit: 100 });
    sendSuccess(res, {
      tasks: tasks.map((task) => ({
        id: task.id,
        mode: task.mode,
        subjectKind: task.subjectKind,
        subjectKey: task.subjectKey,
        priorityClass: task.priorityClass,
        priorityReasons: task.priorityReasons,
        status: task.status,
        attempts: task.attempts,
        availableAt: task.availableAt.toISOString(),
        lastRefusal: task.lastRefusal,
        lastError: task.lastError,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list refresh tasks');
  }
}

/**
 * POST — ask for a refresh.
 *
 * A whole-source pass when no object is named, a targeted re-read when one is.
 * The refusal to schedule a mode the adapter cannot perform lives in the
 * scheduler, so this route reports it rather than deciding it.
 */
export async function requestRefreshHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const parsed = requestRefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const actor = getRequiredOxyUserId(req);
    const now = new Date();

    if (parsed.data.externalObjectKey === undefined) {
      const task = await scheduleSourceRefresh({
        sourceId,
        wantsSnapshot: parsed.data.wantsSnapshot ?? false,
        availableAt: now,
        requestedByOxyUserId: actor,
        now,
      });
      if (task === undefined) {
        sendError(
          res,
          ErrorCodes.VALIDATION_ERROR,
          'No refresh mode is available for this source — check the adapter and the policy',
          409,
        );
        return;
      }
      sendSuccess(res, { taskId: task.id, mode: task.mode, priorityClass: task.priorityClass }, 201);
      return;
    }

    const task = await requestPriorityRefresh({
      sourceId,
      externalObjectKey: parsed.data.externalObjectKey,
      reason: 'clicked',
      requestedByOxyUserId: actor,
      now,
    });
    sendSuccess(res, { taskId: task.id, mode: task.mode, priorityClass: task.priorityClass }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to request a refresh');
  }
}

/** GET — this source's OPEN quarantine findings. */
export async function listQuarantinesHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const findings = await listOpenRunQuarantines(getDb(), { sourceId, limit: 100 });
    sendSuccess(res, {
      quarantines: findings.map((finding) => ({
        id: finding.id,
        runId: finding.runId,
        kind: finding.kind,
        observedValue: finding.observedValue,
        baselineValue: finding.baselineValue,
        detail: finding.detail,
        heldObjects: finding.heldObjects,
        createdAt: finding.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list quarantines');
  }
}

/**
 * POST — publish a quarantined run's output after all.
 *
 * The actor is mandatory and is stored, because
 * `catalog_source_run_quarantines_actor_shape_check` distinguishes a RELEASE
 * (somebody took responsibility) from a CORRECTION (the feed came back into
 * range). An incident review needs to know which.
 */
export async function releaseQuarantineHandler(req: Request, res: Response): Promise<void> {
  try {
    const quarantineId = routeParam(req, 'quarantineId');
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    const released = await releaseRunQuarantine(getDb(), {
      id: quarantineId,
      actorOxyUserId: getRequiredOxyUserId(req),
      note,
      now: new Date(),
    });
    if (released === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No open quarantine with that id', 404);
      return;
    }
    sendSuccess(res, { id: released.id, resolution: released.resolution });
  } catch (err) {
    respondWithError(res, err, 'Failed to release a quarantine');
  }
}

/** POST — drive one refresh tick and one expiry sweep now. The loops' own bodies. */
export async function drainOfferFreshnessHandler(_req: Request, res: Response): Promise<void> {
  try {
    const now = new Date();
    const refresh = await drainOfferRefresh(now);
    const sweep = await sweepExpiredOffers(now);
    sendSuccess(res, { refresh, sweep });
  } catch (err) {
    respondWithError(res, err, 'Failed to drain offer freshness');
  }
}
