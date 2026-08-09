/**
 * The ingestion operator surface (#62 §"Source definition", §"Observability").
 *
 * Configure a source, publish its rights, move its lifecycle, open a run, read
 * the measurements, trace an object, release a quarantine. Every WRITE drives a
 * path that already exists and is already idempotent, so this surface adds
 * buttons and no second way for ingestion to happen.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No "delete a source, a policy, an object or a run".** Issue acceptance 6
 *   is that rights can be withdrawn WITHOUT deleting audit history. No
 *   repository in this domain offers a delete and this surface could not call
 *   one; the only rows that ever leave are the rejection residual, on a clock,
 *   through the shared expiry sweep.
 * - **No "set this object's canonical match".** That is #59's correction
 *   workflow over `match_decisions`, with its own four-eyes and its own
 *   timeline. A shortcut here would be an unreviewed canonical link wearing an
 *   operator's name.
 * - **No "create an offer".** Offers come from the pipeline, after a canonical
 *   variant and a merchant have been resolved. A direct route would be exactly
 *   the write boundary the whole issue exists to establish.
 * - **No credential WRITE and no credential READ.** The config carries a
 *   LOCATOR; the secret lives where the locator says. A route that accepted a
 *   secret would make this the second place secrets live.
 * - **No flag write.** `CATALOG_INGESTION_ENABLED` is read at boot, and a route
 *   that changed it at runtime would make "what was this deployment doing at
 *   14:00" unanswerable from configuration.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CatalogSourceExtractionMode,
  CatalogSourceKind,
  CatalogSourceStatus,
  SourceRecordExternalType,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import { listIngestionSources } from '../db/ingestion/catalogSourceConfigRepository.js';
import { listSourcePolicies } from '../db/ingestion/catalogSourcePolicyRepository.js';
import { listSourceRuns } from '../db/ingestion/catalogSourceRunRepository.js';
import { openSourceRun } from '../db/ingestion/catalogSourceRunRepository.js';
import { releaseSourceObjectQuarantine } from '../db/ingestion/catalogSourceObjectRepository.js';
import {
  readSourceMetrics,
  readSourceRejections,
  traceSourceObject,
} from '../services/ingestion/metrics.js';
import { registeredCatalogSourceProviders } from '../services/ingestion/registry.js';
import { drainCatalogIngestion } from '../services/ingestion/ingest-dispatcher.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
  resolveIngestionSource,
} from '../services/ingestion/source.service.js';
import {
  changeSourceStatusSchema,
  configureSourceSchema,
  openRunSchema,
  publishPolicySchema,
  traceObjectSchema,
} from '../middleware/ingestion-schemas.js';

/**
 * The projection NAMES every field — the `provider_accounts` #46 precedent.
 *
 * `credential_ref` is absent, and its absence is the point: it is a locator
 * rather than a secret, but publishing an SSM path through a debugging surface
 * discloses deployment topology for no operational gain. A `select()` of the
 * whole row would have carried it, which is why this is a projection and not a
 * filter.
 */
function toSourceDTO(input: {
  readonly config: {
    readonly sourceId: string;
    readonly provider: string;
    readonly sourceAccountRef: string | null;
    readonly merchantId: string | null;
    readonly storefrontId: string | null;
    readonly territories: string[];
    readonly fetchCadenceSeconds: number | null;
    readonly freshnessTtlSeconds: number;
    readonly pageSize: number;
    readonly status: string;
    readonly statusReason: string | null;
    readonly healthState: string;
    readonly healthChangedAt: Date | null;
    readonly lastAttemptAt: Date | null;
    readonly lastSuccessAt: Date | null;
    readonly consecutiveFailures: number;
    readonly nextRunAt: Date | null;
    readonly lastError: string | null;
  };
  readonly sourceName: string;
  readonly sourceKind: string;
}) {
  return {
    sourceId: input.config.sourceId,
    name: input.sourceName,
    kind: input.sourceKind,
    provider: input.config.provider,
    sourceAccountRef: input.config.sourceAccountRef,
    merchantId: input.config.merchantId,
    storefrontId: input.config.storefrontId,
    territories: input.config.territories,
    fetchCadenceSeconds: input.config.fetchCadenceSeconds,
    freshnessTtlSeconds: input.config.freshnessTtlSeconds,
    pageSize: input.config.pageSize,
    status: input.config.status,
    statusReason: input.config.statusReason,
    healthState: input.config.healthState,
    healthChangedAt: input.config.healthChangedAt?.toISOString() ?? null,
    lastAttemptAt: input.config.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: input.config.lastSuccessAt?.toISOString() ?? null,
    consecutiveFailures: input.config.consecutiveFailures,
    nextRunAt: input.config.nextRunAt?.toISOString() ?? null,
    lastError: input.config.lastError,
    adapterRegistered: registeredCatalogSourceProviders().includes(input.config.provider),
  };
}

/** GET `/internal/ingestion/sources` — every configured source. */
export async function listIngestionSourcesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const sources = await listIngestionSources(getDb(), 200);
    sendSuccess(res, {
      sources: sources.map(toSourceDTO),
      registeredProviders: registeredCatalogSourceProviders(),
      dispatcherEnabled: config.catalogIngestion.enabled,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list ingestion sources');
  }
}

/** POST `/internal/ingestion/sources` — register or reconfigure a source. */
export async function configureSourceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = configureSourceSchema.parse(req.body);
    const resolved = await configureIngestionSource({
      name: body.name,
      kind: body.kind as CatalogSourceKind,
      provider: body.provider,
      ...(body.sourceAccountRef === undefined ? {} : { sourceAccountRef: body.sourceAccountRef }),
      ...(body.merchantId === undefined ? {} : { merchantId: body.merchantId }),
      ...(body.storefrontId === undefined ? {} : { storefrontId: body.storefrontId }),
      ...(body.territories === undefined ? {} : { territories: body.territories }),
      ...(body.credentialRef === undefined ? {} : { credentialRef: body.credentialRef }),
      ...(body.fetchCadenceSeconds === undefined
        ? {}
        : { fetchCadenceSeconds: body.fetchCadenceSeconds }),
      ...(body.freshnessTtlSeconds === undefined
        ? {}
        : { freshnessTtlSeconds: body.freshnessTtlSeconds }),
      ...(body.rateLimitPerMinute === undefined
        ? {}
        : { rateLimitPerMinute: body.rateLimitPerMinute }),
      ...(body.rateLimitConcurrency === undefined
        ? {}
        : { rateLimitConcurrency: body.rateLimitConcurrency }),
      ...(body.rateLimitMinIntervalMs === undefined
        ? {}
        : { rateLimitMinIntervalMs: body.rateLimitMinIntervalMs }),
      ...(body.pageSize === undefined ? {} : { pageSize: body.pageSize }),
      ...(body.rightsNote === undefined ? {} : { rightsNote: body.rightsNote }),
    });
    sendSuccess(res, { source: toSourceDTO(resolved.source), rights: resolved.rights }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to configure the source');
  }
}

/** GET `/internal/ingestion/sources/:sourceId` — one source with its rights. */
export async function getIngestionSourceHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const resolved = await resolveIngestionSource(sourceId);
    if (resolved === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Source is not configured for ingestion', 404);
      return;
    }
    sendSuccess(res, {
      source: toSourceDTO(resolved.source),
      rights: resolved.rights,
      policyVersion: resolved.policy?.version ?? null,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the source');
  }
}

/**
 * GET `/internal/ingestion/sources/:sourceId/policies` — every rights version.
 *
 * The whole chain, newest first, because the question this answers is "what
 * were we permitted to do in March" — which a surface serving only the active
 * version cannot answer, and which is precisely why withdrawing a right is a
 * new version rather than an edit.
 */
export async function listSourcePoliciesHandler(req: Request, res: Response): Promise<void> {
  try {
    const sourceId = routeParam(req, 'sourceId');
    const policies = await listSourcePolicies(getDb(), sourceId, 100);
    sendSuccess(res, {
      policies: policies.map((policy) => ({
        version: policy.version,
        status: policy.status,
        rights: {
          store: policy.mayStore,
          cache: policy.mayCache,
          cacheTtlSeconds: policy.cacheTtlSeconds,
          display: policy.mayDisplay,
          displayPrice: policy.mayDisplayPrice,
          displayMedia: policy.mayDisplayMedia,
          outboundLink: policy.mayLinkOut,
          affiliateParams: policy.mayAppendAffiliateParams,
          index: policy.mayIndex,
          automatedRefresh: policy.mayRefreshAutomatically,
          extractionMode: policy.extractionMode,
          extractionMaxRequestsPerDay: policy.extractionMaxRequestsPerDay,
        },
        attributionRequired: policy.attributionRequired,
        termsVersion: policy.termsVersion,
        termsUrl: policy.termsUrl,
        reviewedAt: policy.reviewedAt?.toISOString() ?? null,
        reviewedByOxyUserId: policy.reviewedByOxyUserId,
        reviewNote: policy.reviewNote,
        activatedAt: policy.activatedAt?.toISOString() ?? null,
        supersededAt: policy.supersededAt?.toISOString() ?? null,
        supersedesVersion: policy.supersedesVersion,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list the source policies');
  }
}

/** POST `/internal/ingestion/sources/:sourceId/policies` — publish and activate. */
export async function publishSourcePolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = publishPolicySchema.parse(req.body);
    const resolved = await publishIngestionSourcePolicy({
      sourceId: routeParam(req, 'sourceId'),
      reviewedByOxyUserId: getRequiredOxyUserId(req),
      mayDisplay: body.mayDisplay,
      mayStore: body.mayStore,
      mayCache: body.mayCache,
      ...(body.cacheTtlSeconds === undefined ? {} : { cacheTtlSeconds: body.cacheTtlSeconds }),
      mayDisplayPrice: body.mayDisplayPrice,
      mayDisplayMedia: body.mayDisplayMedia,
      mayLinkOut: body.mayLinkOut,
      mayAppendAffiliateParams: body.mayAppendAffiliateParams,
      mayIndex: body.mayIndex,
      mayRefreshAutomatically: body.mayRefreshAutomatically,
      extractionMode: body.extractionMode as CatalogSourceExtractionMode,
      ...(body.extractionMaxRequestsPerDay === undefined
        ? {}
        : { extractionMaxRequestsPerDay: body.extractionMaxRequestsPerDay }),
      ...(body.extractionUserAgent === undefined
        ? {}
        : { extractionUserAgent: body.extractionUserAgent }),
      attributionRequired: body.attributionRequired,
      ...(body.termsVersion === undefined ? {} : { termsVersion: body.termsVersion }),
      ...(body.termsUrl === undefined ? {} : { termsUrl: body.termsUrl }),
      ...(body.reviewNote === undefined ? {} : { reviewNote: body.reviewNote }),
    });
    sendSuccess(
      res,
      { rights: resolved.rights, policyVersion: resolved.policy?.version ?? null },
      201,
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to publish the source policy');
  }
}

/** POST `/internal/ingestion/sources/:sourceId/status` — move the lifecycle. */
export async function changeSourceStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = changeSourceStatusSchema.parse(req.body);
    const resolved = await changeIngestionSourceStatus({
      sourceId: routeParam(req, 'sourceId'),
      status: body.status as CatalogSourceStatus,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason,
    });
    sendSuccess(res, { source: toSourceDTO(resolved.source), rights: resolved.rights });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the source status');
  }
}

/** GET `/internal/ingestion/sources/:sourceId/metrics` — the ten measurements. */
export async function sourceMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const metrics = await readSourceMetrics(routeParam(req, 'sourceId'));
    sendSuccess(res, { metrics });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the source metrics');
  }
}

/** GET `/internal/ingestion/sources/:sourceId/runs` — this source's passes. */
export async function listSourceRunsHandler(req: Request, res: Response): Promise<void> {
  try {
    const runs = await listSourceRuns(getDb(), routeParam(req, 'sourceId'), 50);
    sendSuccess(res, {
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        outcome: run.outcome,
        enumerationComplete: run.enumerationComplete,
        fetched: run.fetched,
        stored: run.stored,
        unchanged: run.unchanged,
        rejected: run.rejected,
        quarantined: run.quarantined,
        matched: run.matched,
        reviewRequired: run.reviewRequired,
        unmatched: run.unmatched,
        offersUpserted: run.offersUpserted,
        offersRetired: run.offersRetired,
        fetchCount: run.fetchCount,
        fetchDurationMs: run.fetchDurationMs,
        rateLimitHits: run.rateLimitHits,
        attempts: run.attempts,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        lastError: run.lastError,
      })),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to list the source runs');
  }
}

/**
 * POST `/internal/ingestion/sources/:sourceId/runs` — open a MANUAL pass.
 *
 * Converges on the open-run unique, so asking twice returns the pass already
 * open rather than starting a competing one. Absent `since` asks for a FULL
 * enumeration, which is the only kind that may retire anything — stated on the
 * schema and worth repeating here, because it is the difference between
 * refreshing a feed and delisting a merchant.
 */
export async function openSourceRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = openRunSchema.parse(req.body ?? {});
    const sourceId = routeParam(req, 'sourceId');
    const resolved = await resolveIngestionSource(sourceId);
    if (resolved === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Source is not configured for ingestion', 404);
      return;
    }
    if (!registeredCatalogSourceProviders().includes(resolved.source.config.provider)) {
      sendError(
        res,
        ErrorCodes.VALIDATION_ERROR,
        `This deployment ships no adapter for provider '${resolved.source.config.provider}'`,
        400,
      );
      return;
    }
    const run = await openSourceRun(getDb(), {
      sourceId,
      kind: 'manual',
      since: body.since === undefined ? null : new Date(body.since),
      requestedByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });
    sendSuccess(res, { runId: run.id, status: run.status }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to open an ingestion run');
  }
}

/**
 * POST `/internal/ingestion/drain` — drive one tick now.
 *
 * The SAME two steps the dispatcher's loop performs, so a manual drain is never
 * a second implementation of the schedule. It works while
 * `CATALOG_INGESTION_ENABLED` is off, which is deliberate: bringing a new feed
 * up by hand before switching the loop on is the supported way to do it.
 */
export async function drainIngestionHandler(_req: Request, res: Response): Promise<void> {
  try {
    const pages = await drainCatalogIngestion();
    sendSuccess(res, { pages });
  } catch (err) {
    respondWithError(res, err, 'Failed to drain ingestion');
  }
}

/** GET `/internal/ingestion/sources/:sourceId/objects/trace` — one object's history. */
export async function traceSourceObjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = traceObjectSchema.parse(req.query);
    const trace = await traceSourceObject({
      sourceId: routeParam(req, 'sourceId'),
      externalType: query.externalType as SourceRecordExternalType,
      externalId: query.externalId,
    });
    sendSuccess(res, { trace });
  } catch (err) {
    respondWithError(res, err, 'Failed to trace the source object');
  }
}

/** GET `/internal/ingestion/sources/:sourceId/rejections` — the residual. */
export async function listSourceRejectionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rejections = await readSourceRejections(routeParam(req, 'sourceId'), 100);
    sendSuccess(res, { rejections });
  } catch (err) {
    respondWithError(res, err, 'Failed to list the source rejections');
  }
}

/**
 * POST `/internal/ingestion/objects/:objectId/release` — let a quarantined
 * object back into the pipeline.
 *
 * An explicit act rather than something the next delivery does: a quarantine is
 * a decision about CONTENT, and the same content arriving again does not answer
 * it. The object returns to `observed`, so the next pass re-examines it from
 * the top rather than resuming mid-pipeline on a stale verdict.
 */
export async function releaseQuarantineHandler(req: Request, res: Response): Promise<void> {
  try {
    const released = await releaseSourceObjectQuarantine(getDb(), routeParam(req, 'objectId'));
    if (!released) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No quarantined object with that id', 404);
      return;
    }
    sendSuccess(res, { released });
  } catch (err) {
    respondWithError(res, err, 'Failed to release the quarantine');
  }
}
