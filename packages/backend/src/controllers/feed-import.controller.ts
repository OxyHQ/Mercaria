/**
 * The feed importer's HTTP surface — merchant and operator (#63 Mapping UX,
 * security 6 and 7).
 *
 * ## Every projection NAMES its fields
 *
 * The `provider_accounts` rule (#46), and here it is what keeps a credential
 * out of a response: `feed_configuration_versions.feed_url` and
 * `.auth_ciphertext` are PROTECTED columns, so the repository never returns
 * them — and the URL is additionally rendered through `redactFeedUrl`, so what
 * a merchant sees is the HOST and nothing after it. A feed URL in this domain
 * is a credential (the networks that matter carry the key in the path or the
 * query), which is why it is redacted even for the store that typed it: a store
 * has members, and a key readable by all of them is a key shared with all of
 * them.
 *
 * ## The tenant boundary is checked ONCE, in one function
 *
 * `assertConfigurationBelongsToStore` is the only path from a `:configurationId`
 * to a row on the merchant surface, and it compares `store_id` against the store
 * `loadStore` resolved. A handler that read the configuration itself would be a
 * second answer to "may this store see this feed", and the second answer is the
 * one that gets it wrong.
 */

import type { Request, RequestHandler, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import {
  findFeedConfiguration,
  listAllFeedConfigurations,
  listFeedConfigurationsForOwner,
  listFeedVersions,
  listFieldMappings,
  listValueMappings,
  type FeedConfigurationRow,
  type FeedConfigurationVersionRow,
} from '../db/feedImport/feedConfigurationRepository.js';
import {
  findFeedImportReport,
  listFeedImportReportEntries,
  listFeedImportReports,
  listFeedUploads,
  summarizeFeedImportReport,
} from '../db/feedImport/feedImportReportRepository.js';
import { findIngestionSource } from '../db/ingestion/catalogSourceConfigRepository.js';
import { listSourceRuns } from '../db/ingestion/catalogSourceRunRepository.js';
import { openSourceRun } from '../db/ingestion/catalogSourceRunRepository.js';
import {
  activateFeedVersion,
  createFeedConfiguration,
  draftFeedVersion,
  revertToFeedVersion,
} from '../services/feed-import/configuration.service.js';
import { FeedImportRefusal } from '../services/feed-import/errors.js';
import { previewFeed } from '../services/feed-import/preview.service.js';
import { redactFeedUrl } from '../services/feed-import/redact.js';
import { resolveFeedImport } from '../services/feed-import/resolve.js';
import {
  completeFeedUploadSession,
  describeFeedUploadSession,
  feedUploadPartUrls,
  loadFeedUploadSession,
  openFeedUploadSession,
  proveFeedUploadPossession,
  type FeedUploadOwner,
  type FeedUploadSessionView,
} from '../services/feed-import/upload-session.service.js';
import { requestFeedValidation } from '../services/feed-import/validation-dispatcher.js';
import {
  findFeedValidationJob,
  type FeedValidationJobRow,
} from '../db/feedImport/feedValidationJobRepository.js';
import {
  conflict,
  forbidden,
  MercariaError,
  notFound,
  respondWithError,
  validationError,
} from '../lib/errors/error-codes.js';
import { ErrorCodes, sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import type { CatalogRefreshMode } from '@mercaria/shared-types';
import type {
  ActivateFeedVersionBody,
  CreateOperatorFeedConfigurationBody,
  DraftFeedVersionBody,
  FeedUploadPartsBody,
  FeedUploadProofBody,
  OpenFeedUploadSessionBody,
} from '../middleware/feed-import-schemas.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * WHOSE feeds this request's handlers act on, set by the router.
       *
       * Optional in the type and REQUIRED at use: `feedOwnerStoreId` throws
       * when it is absent rather than choosing a default, because the only
       * default that could be chosen is one of the two owners and choosing
       * either silently is the failure this property exists to prevent.
       */
      feedOwnerScope?: FeedOwnerScope;
    }
  }
}

/**
 * WHOSE feeds a request acts on, DECLARED by the router rather than inferred.
 *
 * `feed_configurations.owner_kind` has two members and
 * `feed_configurations_owner_shape_check` states the biconditional
 * `(owner_kind = 'merchant') = (store_id is not null)`. A `merchant` feed is a
 * store's own catalogue arriving by file; a `platform` one belongs to Mercaria
 * — an external partner's feed, where the partner is not and never will be a
 * Mercaria store (`docs/runbooks/direct-affiliate-partner.md`).
 *
 * ## Why it is declared and not read off `req.store`
 *
 * "No store loaded ⇒ the platform" is one missing `loadStore` away from turning
 * every merchant route into an operator one, silently and in the direction that
 * grants. So {@link feedOwnerStoreId} THROWS on a request whose router declared
 * nothing, and the two routers each say which they are in one line. An
 * undeclared scope is a wiring mistake, and this is where it is cheapest to
 * find.
 */
export type FeedOwnerScope = 'merchant' | 'platform';

/** The router's declaration. See {@link FeedOwnerScope}. */
export function declareFeedOwnerScope(scope: FeedOwnerScope): RequestHandler {
  return (req, _res, next) => {
    req.feedOwnerScope = scope;
    next();
  };
}

/**
 * The store this request's feeds belong to, or `null` for the platform's own.
 *
 * `null` is the value `feed_configurations.store_id` holds for a platform feed,
 * so it is the value every comparison and every write below wants — not a
 * sentinel this function invented.
 */
function feedOwnerStoreId(req: Request): string | null {
  const scope = req.feedOwnerScope;
  if (scope === undefined) {
    // Not a 404: a client cannot cause this and cannot fix it. It means a
    // router mounted these handlers without saying whose feeds they serve.
    throw new Error('This router mounted the feed handlers without declaring a feed owner scope.');
  }
  if (scope === 'platform') return null;
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

/**
 * The ONE path from a `:configurationId` to a row this request may act on.
 *
 * A configuration belonging to a different owner is answered 404 rather than
 * 403: a distinguishable response would let a store member enumerate which feed
 * ids exist. The comparison is against `store_id` directly, so a platform
 * request (`null`) reaches exactly the platform's own rows and a store's
 * reaches exactly its own — one expression, both directions, with no branch to
 * get backwards.
 */
async function assertConfigurationOwnedByRequester(
  req: Request,
  configurationId: string,
): Promise<FeedConfigurationRow> {
  const storeId = feedOwnerStoreId(req);
  const configuration = await findFeedConfiguration(getDb(), configurationId);
  if (configuration === undefined || configuration.storeId !== storeId) {
    throw notFound('Feed configuration not found');
  }
  return configuration;
}

/** The public shape of a configuration. Names every field. */
function toConfigurationDTO(row: FeedConfigurationRow): Record<string, unknown> {
  return {
    id: row.id,
    sourceId: row.sourceId,
    ownerKind: row.ownerKind,
    storeId: row.storeId,
    label: row.label,
    identityKeyFields: row.identityKeyFields,
    lastFetchedAt: row.lastFetchedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The public shape of a mapping version.
 *
 * `feedUrl` is not on the row at all — the repository reads `publicColumns` —
 * and `feedUrlHost` is what a merchant sees instead, which is enough to confirm
 * WHICH provider a version fetches from and carries none of the key. There is
 * no `authSecret`, `authCiphertext` or any derivative of either.
 */
function toVersionDTO(row: FeedConfigurationVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    configurationId: row.configurationId,
    version: row.version,
    status: row.status,
    fetchMode: row.fetchMode,
    uploadId: row.uploadId,
    format: row.format,
    delimiter: row.delimiter,
    quoteChar: row.quoteChar,
    encoding: row.encoding,
    compression: row.compression,
    recordPath: row.recordPath,
    hasHeaderRow: row.hasHeaderRow,
    listSeparator: row.listSeparator,
    defaultCurrency: row.defaultCurrency,
    defaultCountry: row.defaultCountry,
    defaultLanguage: row.defaultLanguage,
    deliveryMode: row.deliveryMode,
    authKind: row.authKind,
    authParamName: row.authParamName,
    validatedReportId: row.validatedReportId,
    activatedAt: row.activatedAt,
    activatedByOxyUserId: row.activatedByOxyUserId,
    supersededAt: row.supersededAt,
    supersedesVersion: row.supersedesVersion,
    mappingNote: row.mappingNote,
    createdAt: row.createdAt,
  };
}

/** A refusal a merchant can act on, never a stack trace and never a URL. */
function respondWithFeedError(res: Response, error: unknown, context: string): void {
  if (error instanceof FeedImportRefusal) {
    log.general.warn({ reason: error.reason, context }, '[FeedImport] refused');
    const refusal =
      error.reason === 'download_too_large'
        ? new MercariaError({
            code: ErrorCodes.VALIDATION_ERROR,
            message: error.message,
            httpStatus: 413,
          })
        : validationError(error.message);
    respondWithError(res, refusal, 'Feed request failed');
    return;
  }
  respondWithError(res, error, 'Feed request failed');
}

// ── Merchant surface ────────────────────────────────────────────────────────

/** GET the requester's feeds — `/admin/stores/:storeId/feeds` or `/internal/feed-imports/platform`. */
export async function listFeedsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listFeedConfigurationsForOwner(getDb(), feedOwnerStoreId(req));
    sendSuccess(res, rows.map(toConfigurationDTO));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'listFeeds');
  }
}

/** POST a new configuration for the requester's own owner. */
export async function createFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    // The OPERATOR body, which is the merchant body plus `sourceKind`. Reading
    // the wider type unconditionally is safe because the merchant schema is
    // `.strict()` and does not declare the field, so a store's request can
    // never carry one — the narrowing is done by the validator on the route,
    // where a reviewer can see which schema each surface uses.
    const body = req.body as CreateOperatorFeedConfigurationBody;
    const configuration = await createFeedConfiguration({
      storeId: feedOwnerStoreId(req),
      ...(body.sourceKind === undefined ? {} : { sourceKind: body.sourceKind }),
      sourceName: body.sourceName,
      label: body.label,
      identityKeyFields: body.identityKeyFields,
      ...(body.merchantId === undefined ? {} : { merchantId: body.merchantId }),
      ...(body.territories === undefined ? {} : { territories: body.territories }),
      ...(body.fetchCadenceSeconds === undefined
        ? {}
        : { fetchCadenceSeconds: body.fetchCadenceSeconds }),
      ...(body.freshnessTtlSeconds === undefined
        ? {}
        : { freshnessTtlSeconds: body.freshnessTtlSeconds }),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, toConfigurationDTO(configuration), 201);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'createFeed');
  }
}

/** GET …/feeds/:configurationId */
export async function getFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const versions = await listFeedVersions(getDb(), configuration.id);
    sendSuccess(res, {
      configuration: toConfigurationDTO(configuration),
      versions: versions.map(toVersionDTO),
    });
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'getFeed');
  }
}

/** GET …/feeds/:configurationId/status — issue Mapping UX 7. */
export async function getFeedStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    sendSuccess(res, await composeFeedStatus(configuration));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'getFeedStatus');
  }
}

/** POST …/feeds/:configurationId/versions */
export async function draftFeedVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const body = req.body as DraftFeedVersionBody;
    // Field by field rather than a spread: the zod-inferred body types every
    // member as optional under this package's `strict: false`, so a spread
    // silently widens `fetchMode`, `format` and `deliveryMode` — the three that
    // decide how a stranger's file is read and whether an omitted row means
    // anything — into `undefined`.
    const version = await draftFeedVersion({
      configurationId: configuration.id,
      fetchMode: body.fetchMode,
      format: body.format,
      deliveryMode: body.deliveryMode,
      // Re-composed rather than passed through, for the reason above: the
      // inferred element type makes `role` optional, and a mapping with no role
      // is a mapping that fills nothing.
      fieldMappings: body.fieldMappings.map((mapping) => ({
        role: mapping.role,
        ...(mapping.sourceField === undefined ? {} : { sourceField: mapping.sourceField }),
        ...(mapping.constantValue === undefined ? {} : { constantValue: mapping.constantValue }),
        ...(mapping.transform === undefined ? {} : { transform: mapping.transform }),
      })),
      ...(body.feedUrl === undefined ? {} : { feedUrl: body.feedUrl }),
      ...(body.uploadId === undefined ? {} : { uploadId: body.uploadId }),
      ...(body.delimiter === undefined ? {} : { delimiter: body.delimiter }),
      ...(body.quoteChar === undefined ? {} : { quoteChar: body.quoteChar }),
      ...(body.encoding === undefined ? {} : { encoding: body.encoding }),
      ...(body.compression === undefined ? {} : { compression: body.compression }),
      ...(body.recordPath === undefined ? {} : { recordPath: body.recordPath }),
      ...(body.hasHeaderRow === undefined ? {} : { hasHeaderRow: body.hasHeaderRow }),
      ...(body.listSeparator === undefined ? {} : { listSeparator: body.listSeparator }),
      ...(body.defaultCurrency === undefined ? {} : { defaultCurrency: body.defaultCurrency }),
      ...(body.defaultCountry === undefined ? {} : { defaultCountry: body.defaultCountry }),
      ...(body.defaultLanguage === undefined ? {} : { defaultLanguage: body.defaultLanguage }),
      ...(body.authKind === undefined ? {} : { authKind: body.authKind }),
      ...(body.authSecret === undefined ? {} : { authSecret: body.authSecret }),
      ...(body.authParamName === undefined ? {} : { authParamName: body.authParamName }),
      ...(body.mappingNote === undefined ? {} : { mappingNote: body.mappingNote }),
      ...(body.valueMappings === undefined
        ? {}
        : {
            valueMappings: body.valueMappings.map((mapping) => ({
              role: mapping.role,
              sourceValue: mapping.sourceValue,
              targetValue: mapping.targetValue,
            })),
          }),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, toVersionDTO(version), 201);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'draftFeedVersion');
  }
}

/** POST …/feeds/:configurationId/versions/:versionId/preview */
export async function previewFeedVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const preview = await previewFeed({
      configurationId: configuration.id,
      versionId: routeParam(req, 'versionId'),
    });
    sendSuccess(res, preview);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'previewFeedVersion');
  }
}

/**
 * POST …/feeds/:configurationId/versions/:versionId/validate
 *
 * 202 and a job to poll, never the report itself: a validation reads and stages
 * the WHOLE feed, which outlives the load balancer's idle timeout for any feed
 * worth validating (`services/feed-import/validation-dispatcher.ts`). Asking
 * again while one is queued or running answers that same job.
 */
export async function validateFeedVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const job = await requestFeedValidation({
      configurationId: configuration.id,
      versionId: routeParam(req, 'versionId'),
      requestedByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, toValidationDTO(job), 202);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'validateFeedVersion');
  }
}

/** GET …/feeds/:configurationId/versions/:versionId/validations/:validationId */
export async function getFeedValidationHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const job = await findFeedValidationJob(getDb(), routeParam(req, 'validationId'));
    if (
      job === undefined ||
      job.configurationId !== configuration.id ||
      job.versionId !== routeParam(req, 'versionId')
    ) {
      throw notFound('Validation not found for this feed');
    }
    sendSuccess(res, toValidationDTO(job));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'getFeedValidation');
  }
}

/**
 * The public shape of a validation job. Names every field; the lease is the
 * dispatcher's business and is not projected.
 */
function toValidationDTO(job: FeedValidationJobRow): Record<string, unknown> {
  return {
    id: job.id,
    configurationId: job.configurationId,
    versionId: job.versionId,
    status: job.status,
    reportId: job.reportId,
    failureReason: job.failureReason,
    // A refusal's own bounded text — never a feed value or a URL.
    message: job.status === 'completed' ? null : job.lastError,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** POST …/feeds/:configurationId/versions/:versionId/activate */
export async function activateFeedVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const body = req.body as ActivateFeedVersionBody;
    await activateFeedVersion({
      configurationId: configuration.id,
      versionId: routeParam(req, 'versionId'),
      reportId: body.reportId,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { activated: true });
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'activateFeedVersion');
  }
}

/** POST …/feeds/:configurationId/versions/:versionId/revert */
export async function revertFeedVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const version = await revertToFeedVersion({
      configurationId: configuration.id,
      versionId: routeParam(req, 'versionId'),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, toVersionDTO(version), 201);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'revertFeedVersion');
  }
}

/** The tenant facts a session's every check reads. */
function uploadOwnerOf(configuration: FeedConfigurationRow): FeedUploadOwner {
  return { configurationId: configuration.id, storeId: configuration.storeId };
}

/**
 * The HTTP answer for a session's state after a client asked it to move: the
 * upload when it completed, 202 while storage verifies, and a refusal that
 * names what to do otherwise. A plain read (`GET`) always answers 200.
 */
function sendSessionOutcome(res: Response, view: FeedUploadSessionView): void {
  switch (view.status) {
    case 'completed':
      sendSuccess(res, view, 201);
      return;
    case 'verifying':
      sendSuccess(res, view, 202);
      return;
    case 'proof_required':
      sendSuccess(res, view, 200);
      return;
    case 'uploading':
      throw conflict(
        'Storage does not hold every part yet. Read the session for `uploadedParts`, send ' +
          'the missing parts, and complete again.',
      );
    case 'failed':
      throw new MercariaError({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `The upload was refused (${view.failure ?? 'storage_refused'}). Open a new upload.`,
        httpStatus: 422,
      });
  }
}

/**
 * POST …/feeds/:configurationId/upload-sessions
 *
 * Open a DIRECT upload. The feed never rides a request to this API — a feed is
 * gigabytes and the proxy in front of it refuses a body over 100 MB — so the
 * client PUTs presigned parts to storage itself (`upload-session.service.ts`
 * documents the protocol). 201 with the session: `uploading` with part URLs,
 * `proof_required` with the range to send, or `completed` with the upload.
 */
export async function openFeedUploadSessionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const body = req.body as OpenFeedUploadSessionBody;
    const view = await openFeedUploadSession({
      owner: uploadOwnerOf(configuration),
      filename: body.filename,
      compression: body.compression,
      byteSize: body.byteSize,
      sha256: body.sha256,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view, 201);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'openFeedUploadSession');
  }
}

/** GET …/feeds/:configurationId/upload-sessions/:sessionId — and finish a verifying one. */
export async function getFeedUploadSessionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const session = await loadFeedUploadSession(
      uploadOwnerOf(configuration),
      routeParam(req, 'sessionId'),
    );
    sendSuccess(res, await describeFeedUploadSession(session));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'getFeedUploadSession');
  }
}

/** POST …/feeds/:configurationId/upload-sessions/:sessionId/parts */
export async function feedUploadPartsHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const session = await loadFeedUploadSession(
      uploadOwnerOf(configuration),
      routeParam(req, 'sessionId'),
    );
    const body = req.body as FeedUploadPartsBody;
    sendSuccess(res, { parts: await feedUploadPartUrls(session, body.partNumbers) });
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'feedUploadParts');
  }
}

/** POST …/feeds/:configurationId/upload-sessions/:sessionId/complete */
export async function completeFeedUploadSessionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const session = await loadFeedUploadSession(
      uploadOwnerOf(configuration),
      routeParam(req, 'sessionId'),
    );
    sendSessionOutcome(res, await completeFeedUploadSession(session));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'completeFeedUploadSession');
  }
}

/** POST …/feeds/:configurationId/upload-sessions/:sessionId/proof */
export async function proveFeedUploadSessionHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const session = await loadFeedUploadSession(
      uploadOwnerOf(configuration),
      routeParam(req, 'sessionId'),
    );
    const body = req.body as FeedUploadProofBody;
    sendSessionOutcome(
      res,
      await proveFeedUploadPossession(session, Buffer.from(body.bytes, 'base64')),
    );
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'proveFeedUploadSession');
  }
}

/** GET …/feeds/:configurationId/uploads */
export async function listFeedUploadsHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const rows = await listFeedUploads(getDb(), configuration.id, 50);
    sendSuccess(
      res,
      rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        byteSize: row.byteSize,
        compression: row.compression,
        status: row.status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
    );
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'listFeedUploads');
  }
}

/** GET …/feeds/:configurationId/reports */
export async function listFeedReportsHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const rows = await listFeedImportReports(getDb(), configuration.id, 50);
    sendSuccess(res, rows);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'listFeedReports');
  }
}

/** GET …/feeds/:configurationId/reports/:reportId */
export async function getFeedReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const report = await findFeedImportReport(getDb(), routeParam(req, 'reportId'));
    if (report === undefined || report.configurationId !== configuration.id) {
      throw notFound('Report not found for this feed');
    }
    sendSuccess(res, {
      report,
      summary: await summarizeFeedImportReport(getDb(), report.id),
    });
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'getFeedReport');
  }
}

/**
 * GET …/feeds/:configurationId/reports/:reportId/download
 *
 * A CSV of the report's entries: a record INDEX, an issue code, a severity, the
 * Mercaria role and the merchant's own column name — and no VALUE, except the
 * three issue codes whose values come from a closed external vocabulary and are
 * bounded to sixteen characters of a restricted alphabet by CHECK. A merchant
 * has the file; the index is what lets them find the row, and the report does
 * not need to hand back the contents of something they already hold.
 */
export async function downloadFeedReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const report = await findFeedImportReport(getDb(), routeParam(req, 'reportId'));
    if (report === undefined || report.configurationId !== configuration.id) {
      throw notFound('Report not found for this feed');
    }
    const entries = await listFeedImportReportEntries(
      getDb(),
      report.id,
      config.feedImport.maxReportEntries,
    );
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="feed-report-${report.id}.csv"`);
    res.write('record_index,issue_code,severity,role,source_field,external_id,observed_token\n');
    for (const entry of entries) {
      res.write(
        `${[
          String(entry.recordIndex),
          entry.issueCode,
          entry.severity,
          entry.role ?? '',
          csvCell(entry.sourceField),
          csvCell(entry.externalId),
          entry.observedToken ?? '',
        ].join(',')}\n`,
      );
    }
    res.end();
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'downloadFeedReport');
  }
}

/**
 * Quote a cell that could contain the delimiter.
 *
 * A field NAME comes from the merchant's own file and may contain a comma, a
 * quote or a newline. Emitting it raw would make the report Mercaria produces
 * unparseable by the same rules it insists a merchant's feed follow, which is a
 * poor argument to be having.
 */
function csvCell(value: string | null): string {
  if (value === null || value === '') return '';
  return `"${value.replace(/"/gu, '""')}"`;
}

/** POST …/feeds/:configurationId/sync — a MANUAL pass. */
export async function syncFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const configuration = await assertConfigurationOwnedByRequester(
      req,
      routeParam(req, 'configurationId'),
    );
    const run = await openSourceRun(getDb(), {
      sourceId: configuration.sourceId,
      kind: 'manual',
      refreshMode: await manualRefreshModeFor(configuration.id),
      // No watermark: this adapter has no `since` call — a feed is one file at
      // one URL — so what makes a pass incremental is the PUBLISHER's delivery
      // mode, never a parameter Mercaria supplies.
      since: null,
      requestedByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });
    sendSuccess(res, { runId: run.id, status: run.status }, 202);
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'syncFeed');
  }
}

/**
 * Which refresh mode a MANUAL sync of this configuration opens (#68 scheduler 1).
 *
 * It is read from the ACTIVE version's delivery mode rather than defaulted,
 * because the mode a run carries is what `mayRetireUnseen` consults one layer
 * down: a delta feed opened as `full_snapshot` would be asking the framework
 * for permission to retire every record the publisher chose not to repeat that
 * day. The adapter's own `complete` flag refuses that independently, and
 * agreeing here rather than relying on it means the two mechanisms say the same
 * thing instead of one quietly correcting the other.
 *
 * No active version is a REFUSAL and not a guessed mode: the run would refuse
 * at fetch time anyway, and inventing `full_snapshot` for a feed whose delivery
 * mode nobody can read is exactly the guess #68 declines to default.
 */
async function manualRefreshModeFor(configurationId: string): Promise<CatalogRefreshMode> {
  const feed = await resolveFeedImport(configurationId);
  if (feed === null) {
    throw conflict(
      'This feed has no ACTIVE mapping version, so a sync cannot say what kind of pass it is.',
    );
  }
  return feed.deliveryMode === 'snapshot' ? 'full_snapshot' : 'incremental';
}

/** Last run, next run, counts and failures (issue Mapping UX 7). */
async function composeFeedStatus(
  configuration: FeedConfigurationRow,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const source = await findIngestionSource(db, configuration.sourceId);
  const runs = await listSourceRuns(db, configuration.sourceId, 5);
  const versions = await listFeedVersions(db, configuration.id);
  const active = versions.find((version) => version.status === 'active');

  return {
    configuration: toConfigurationDTO(configuration),
    activeVersion: active === undefined ? null : toVersionDTO(active),
    source:
      source === undefined
        ? null
        : {
            status: source.config.status,
            healthState: source.config.healthState,
            lastAttemptAt: source.config.lastAttemptAt,
            lastSuccessAt: source.config.lastSuccessAt,
            nextRunAt: source.config.nextRunAt,
            consecutiveFailures: source.config.consecutiveFailures,
            // Redacted even here: a refusal composed by this domain never
            // interpolates a URL, and this is the belt-and-braces pass over one
            // that came from somewhere else.
            lastError: source.config.lastError,
          },
    runs: runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      outcome: run.outcome,
      fetched: run.fetched,
      stored: run.stored,
      unchanged: run.unchanged,
      rejected: run.rejected,
      offersUpserted: run.offersUpserted,
      offersRetired: run.offersRetired,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
  };
}

// ── Operator surface ────────────────────────────────────────────────────────

/** GET /internal/feed-imports — every feed, whoever manages it. */
export async function listAllFeedsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await listAllFeedConfigurations(getDb(), 200);
    sendSuccess(res, rows.map(toConfigurationDTO));
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'listAllFeeds');
  }
}

/**
 * GET /internal/feed-imports/:configurationId — one feed's whole trace.
 *
 * The operator projection carries the feed URL's HOST and never its path or
 * query, which is the same redaction the merchant surface applies and for the
 * same reason: an operator reading a source's configuration needs to know which
 * provider it fetches from, not the key it fetches with.
 */
export async function traceFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const configuration = await findFeedConfiguration(db, routeParam(req, 'configurationId'));
    if (configuration === undefined) throw notFound('Feed configuration not found');
    const versions = await listFeedVersions(db, configuration.id);
    const mappings = await Promise.all(
      versions.map(async (version) => ({
        versionId: version.id,
        fields: await listFieldMappings(db, version.id),
        values: await listValueMappings(db, version.id),
      })),
    );
    sendSuccess(res, {
      ...(await composeFeedStatus(configuration)),
      versions: versions.map(toVersionDTO),
      mappings,
      reports: await listFeedImportReports(db, configuration.id, 20),
    });
  } catch (error: unknown) {
    respondWithFeedError(res, error, 'traceFeed');
  }
}

/**
 * The redacted host of a feed URL, for a caller that holds one.
 *
 * Exported so the operator surface and any future projection use the SAME
 * rendering; there is deliberately no unredacted form anywhere in this file.
 */
export function feedUrlHost(url: string | null): string | null {
  return redactFeedUrl(url);
}

/** A guard the routers use so an unmounted surface is never half-mounted. */
export function assertFeedImportEnabled(): void {
  if (!config.feedImport.enabled) {
    throw forbidden('The feed importer is not enabled on this deployment.');
  }
}
