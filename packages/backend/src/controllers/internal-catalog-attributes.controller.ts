/**
 * The OPERATOR attribute surface (#94 registry rules, coverage rules, API
 * rule 2).
 *
 * Everything the public surface deliberately withholds: the source values behind
 * a selected one, the confidence, the method, the definition version and the
 * normalization ruleset. Plus the writes — drafting and publishing a definition
 * version, recording a per-source mapping, applying a source observation, and
 * working the review queue.
 *
 * Behind `CATALOG_OPERATOR_OXY_USER_IDS`, the same allow-list #54, #55, #56 and
 * #83 use. Who may reshape the catalogue is one question with one answer.
 */

import type { Request, Response } from 'express';
import { getDb } from '../db/postgres.js';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  deprecateAttributeDefinition,
  draftAttributeDefinition,
  listDefinitionHistory,
  publishAttributeDefinition,
  resolveActiveDefinition,
  resolveAllActiveDefinitions,
  retireAttributeDefinition,
  toAttributeDefinitionDto,
} from '../services/attributes/definition-registry.service.js';
import {
  applyAttributeObservation,
  isAttributeEntityKind,
  listEntityAttributeValues,
} from '../services/attributes/attribute-observation.service.js';
import {
  listAttributeReviewQueue,
  resolveAttributeReview,
} from '../services/attributes/review-queue.service.js';
import { measureCoverage, prioritizeCoverage } from '../services/attributes/coverage.service.js';
import {
  listPendingReindexRequests,
  upsertAttributeSourceMapping,
} from '../db/attributes/attributeOpsRepository.js';
import type {
  AttributeDefinitionDraftBody,
  AttributeObservationBody,
  AttributeReviewResolveBody,
  AttributeSourceMappingBody,
} from '../middleware/attribute-schemas.js';

/** POST /internal/catalog-attributes/definitions — draft a NEW version. */
export async function draftDefinitionHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as AttributeDefinitionDraftBody;
    const definition = await draftAttributeDefinition({
      ...body,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, definition, 201);
  } catch (error) {
    respondWithError(res, error, 'Drafting the attribute definition failed');
  }
}

/** POST /internal/catalog-attributes/definitions/:key/versions/:version/publish */
export async function publishDefinitionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { key, version } = req.params as { key: string; version: string };
    const definition = await publishAttributeDefinition(
      key,
      parseVersion(version),
      catalogOperatorId(req),
    );
    sendSuccess(res, definition);
  } catch (error) {
    respondWithError(res, error, 'Publishing the attribute definition failed');
  }
}

/** POST /internal/catalog-attributes/definitions/:key/versions/:version/deprecate */
export async function deprecateDefinitionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { key, version } = req.params as { key: string; version: string };
    sendSuccess(res, await deprecateAttributeDefinition(key, parseVersion(version)));
  } catch (error) {
    respondWithError(res, error, 'Deprecating the attribute definition failed');
  }
}

/** POST /internal/catalog-attributes/definitions/:key/versions/:version/retire */
export async function retireDefinitionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { key, version } = req.params as { key: string; version: string };
    sendSuccess(res, await retireAttributeDefinition(key, parseVersion(version)));
  } catch (error) {
    respondWithError(res, error, 'Retiring the attribute definition failed');
  }
}

/** GET /internal/catalog-attributes/definitions/:key/versions — the full history. */
export async function listDefinitionHistoryHandler(req: Request, res: Response): Promise<void> {
  try {
    const { key } = req.params as { key: string };
    const versions = await listDefinitionHistory(getDb(), key);
    if (versions.length === 0) throw notFound(`No attribute definition for '${key}'.`);
    sendSuccess(res, { versions: versions.map(toAttributeDefinitionDto) });
  } catch (error) {
    respondWithError(res, error, 'Listing the attribute definition history failed');
  }
}

/** POST /internal/catalog-attributes/source-mappings — how a feed's fields map. */
export async function upsertSourceMappingHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as AttributeSourceMappingBody;
    const mapping = await upsertAttributeSourceMapping(getDb(), {
      catalogSourceId: body.catalogSourceId,
      sourceField: body.sourceField.trim().toLowerCase(),
      attributeKey: body.attributeKey,
      assumedUnit: body.assumedUnit ?? null,
      componentAxis: body.componentAxis ?? null,
      categoryIds: body.categoryIds ?? [],
      note: body.note ?? null,
      createdByOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, mapping, 201);
  } catch (error) {
    respondWithError(res, error, 'Recording the source mapping failed');
  }
}

/**
 * POST /internal/catalog-attributes/observations — record what a SOURCE said.
 *
 * The body carries no normalized value and no selection, deliberately: this
 * endpoint takes source facts, and what they normalize to is the registry's
 * decision. A caller cannot write a magnitude no source expressed.
 */
export async function applyObservationHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as AttributeObservationBody;
    const result = await applyAttributeObservation({
      grain: { kind: body.entityKind, id: body.entityId },
      attributeKey: body.attributeKey,
      displayValue: body.displayValue,
      sourceRecordId: body.sourceRecordId,
      ...(body.catalogSourceId === undefined ? {} : { catalogSourceId: body.catalogSourceId }),
      ...(body.sourceField === undefined ? {} : { sourceField: body.sourceField }),
      ...(body.method === undefined ? {} : { method: body.method }),
      ...(body.locale === undefined ? {} : { locale: body.locale }),
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
    });
    sendSuccess(
      res,
      {
        outcome: result.outcome,
        values: result.values.map((value) => ({
          id: value.id,
          attributeKey: value.attributeKey,
          normalizationState: value.normalizationState,
          selectionState: value.selectionState,
          componentAxis: value.componentAxis,
          position: value.position,
        })),
      },
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Recording the attribute observation failed');
  }
}

/**
 * GET /internal/catalog-attributes/values/:entityKind/:entityId — SOURCE values.
 *
 * Every recorded fact, conflicts and refusals included, with the provenance the
 * public surface withholds (#94 API rule 2: "retrieve selected and source
 * attribute values for AUTHORIZED callers").
 */
export async function listSourceValuesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { entityKind, entityId } = req.params as { entityKind: string; entityId: string };
    if (!isAttributeEntityKind(entityKind)) {
      throw validationError("An attribute value belongs to a 'product' or a 'variant'.");
    }
    const rows = await listEntityAttributeValues({ kind: entityKind, id: entityId });
    sendSuccess(res, {
      entityKind,
      entityId,
      values: rows.map((row) => ({
        id: row.id,
        attributeKey: row.attributeKey,
        definitionVersion: row.definitionVersion,
        normalizationState: row.normalizationState,
        selectionState: row.selectionState,
        verificationState: row.verificationState,
        sourceDisplayValue: row.sourceDisplayValue,
        sourceUnit: row.sourceUnit,
        normalizedText: row.normalizedText,
        normalizedNumber: row.normalizedNumber,
        normalizedNumberMax: row.normalizedNumberMax,
        rangeLowerInclusive: row.rangeLowerInclusive,
        rangeUpperInclusive: row.rangeUpperInclusive,
        normalizedUnit: row.normalizedUnit,
        normalizedBoolean: row.normalizedBoolean,
        normalizedDate: row.normalizedDate?.toISOString() ?? null,
        normalizedAmountMinor: row.normalizedAmountMinor,
        normalizedCurrency: row.normalizedCurrency,
        componentAxis: row.componentAxis,
        position: row.position,
        locale: row.locale,
        sourceRecordId: row.sourceRecordId,
        observedAt: row.observedAt?.toISOString() ?? null,
        method: row.method,
        confidence: row.confidence,
        normalizationRuleVersion: row.normalizationRuleVersion,
      })),
    });
  } catch (error) {
    respondWithError(res, error, 'Reading the source attribute values failed');
  }
}

/** GET /internal/catalog-attributes/reviews — the conflicting-value queue. */
export async function listReviewsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { attributeKey?: string; limit?: number; offset?: number };
    sendSuccess(res, { reviews: await listAttributeReviewQueue(query) });
  } catch (error) {
    respondWithError(res, error, 'Listing the attribute review queue failed');
  }
}

/** POST /internal/catalog-attributes/reviews/:id/resolve */
export async function resolveReviewHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const body = req.body as AttributeReviewResolveBody;
    const review = await resolveAttributeReview({
      reviewId: id,
      actorOxyUserId: catalogOperatorId(req),
      state: body.state,
      ...(body.selectedValueId === undefined ? {} : { selectedValueId: body.selectedValueId }),
    });
    sendSuccess(res, review);
  } catch (error) {
    respondWithError(res, error, 'Resolving the attribute review failed');
  }
}

/** GET /internal/catalog-attributes/coverage — completeness by category and source. */
export async function coverageHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      entityKind?: 'product' | 'variant';
      categoryId?: string;
      catalogSourceId?: string;
    };
    const db = getDb();
    const cells = await measureCoverage(db, {
      entityKind: query.entityKind ?? 'product',
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.catalogSourceId === undefined ? {} : { catalogSourceId: query.catalogSourceId }),
    });
    const hardKeys = new Set(
      (await resolveAllActiveDefinitions(db))
        .filter((definition) => definition.row.hardConstraintCapable)
        .map((definition) => definition.row.key),
    );
    sendSuccess(res, { coverage: prioritizeCoverage(cells, hardKeys) });
  } catch (error) {
    respondWithError(res, error, 'Measuring attribute coverage failed');
  }
}

/**
 * GET /internal/catalog-attributes/reindex-requests — what is waiting.
 *
 * Read-only, and there is deliberately no "drain" endpoint: the consumer of
 * these requests is a search index #61 has not decided on, and an operator
 * button that marked them processed would discard work nobody did.
 */
export async function listReindexRequestsHandler(req: Request, res: Response): Promise<void> {
  try {
    const requests = await listPendingReindexRequests(getDb(), 200);
    sendSuccess(res, { requests, pendingReturned: requests.length });
  } catch (error) {
    respondWithError(res, error, 'Listing reindex requests failed');
  }
}

/** GET /internal/catalog-attributes/definitions/:key — the ACTIVE version, hydrated. */
export async function getActiveDefinitionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { key } = req.params as { key: string };
    const definition = await resolveActiveDefinition(getDb(), key);
    if (!definition) throw notFound(`No active attribute definition for '${key}'.`);
    sendSuccess(res, toAttributeDefinitionDto(definition));
  } catch (error) {
    respondWithError(res, error, 'Reading the attribute definition failed');
  }
}

/** A path version, refused rather than coerced — `NaN` is not version 1. */
function parseVersion(raw: string): number {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw validationError(`'${raw}' is not an attribute definition version.`);
  }
  return version;
}
