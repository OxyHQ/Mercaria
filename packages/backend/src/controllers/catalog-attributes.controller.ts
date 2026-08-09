/**
 * The PUBLIC attribute surface (#94 API rules 1, 3, 4, 5, 6, 7).
 *
 * Four questions a shopper's client may ask: what attributes does this category
 * have, is this set of requirements answerable, does this product meet them, and
 * what filters can I offer. Nothing here writes.
 *
 * **Provenance stays out.** The value projection is
 * {@link PublicAttributeValue} — the value, its unit, and whether Mercaria has a
 * recorded observation behind it. No source record id, no confidence, no method,
 * no normalization rule version (#94 API rule 7). An operator who needs those
 * uses `/internal/catalog-attributes`, which is a different surface behind a
 * different gate.
 */

import type { Request, Response } from 'express';
import type {
  AttributeDefinition,
  ConstraintSet,
  ProductConstraint,
  PublicAttributeValue,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import {
  resolveActiveDefinition,
  resolveAllActiveDefinitions,
  resolveDefinitionVersion,
  resolveDefinitionsForCategory,
  toAttributeDefinitionDto,
} from '../services/attributes/definition-registry.service.js';
import { facetsForCategory } from '../services/attributes/facets.service.js';
import { validateConstraintSet } from '../services/attributes/constraint-validation.js';
import { evaluateCandidate } from '../services/attributes/constraint-evaluation.js';
import { explainEvaluation } from '../services/attributes/constraint-explanation.js';
import {
  loadCandidateFacts,
  offerContextFor,
} from '../services/attributes/entity-facts.service.js';
import { listSelectedAttributeValues } from '../db/canonical/attributeRepository.js';
import { isAttributeEntityKind } from '../services/attributes/attribute-observation.service.js';
import type {
  ConstraintSetEvaluateBody,
  ConstraintSetValidateBody,
} from '../middleware/attribute-schemas.js';

/** GET /catalog-attributes/definitions — by category, or by key and version. */
export async function listAttributeDefinitionsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const query = req.query as { categoryId?: string; key?: string; version?: number };
    const db = getDb();

    if (query.key !== undefined) {
      const resolved =
        query.version === undefined
          ? await resolveActiveDefinition(db, query.key)
          : await resolveDefinitionVersion(db, query.key, query.version);
      if (!resolved) throw notFound(`No attribute definition for '${query.key}'.`);
      sendSuccess(res, toAttributeDefinitionDto(resolved));
      return;
    }

    const resolved =
      query.categoryId === undefined
        ? await resolveAllActiveDefinitions(db)
        : await resolveDefinitionsForCategory(db, query.categoryId);
    const definitions: AttributeDefinition[] = resolved.map(toAttributeDefinitionDto);
    sendSuccess(res, { definitions });
  } catch (error) {
    respondWithError(res, error, 'Listing attribute definitions failed');
  }
}

/** GET /catalog-attributes/facets — filter facets for one category. */
export async function listAttributeFacetsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { categoryId } = req.query as { categoryId: string };
    sendSuccess(res, { facets: await facetsForCategory(getDb(), categoryId) });
  } catch (error) {
    respondWithError(res, error, 'Listing attribute facets failed');
  }
}

/**
 * GET /catalog-attributes/values/:entityKind/:entityId — SELECTED values only.
 *
 * The public projection. A conflicting or unparsed value is not returned at all
 * — Mercaria is not willing to state it, so publishing it beside the ones it is
 * willing to state would misrepresent both.
 */
export async function getPublicAttributeValuesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { entityKind, entityId } = req.params as { entityKind: string; entityId: string };
    if (!isAttributeEntityKind(entityKind)) {
      throw validationError("An attribute value belongs to a 'product' or a 'variant'.");
    }
    const db = getDb();
    const rows = await listSelectedAttributeValues(db, entityKind, [entityId]);

    const values: PublicAttributeValue[] = [];
    for (const row of rows) {
      const definition = await resolveActiveDefinition(db, row.attributeKey);
      // An `operator_only` attribute never appears in a public DTO. Checking the
      // ACTIVE definition rather than the row's own version is deliberate: the
      // display policy is a decision about what may be shown NOW, and a value
      // recorded under a version that permitted it must not keep that permission
      // after the policy changed.
      if (definition?.row.displayPolicy === 'operator_only') continue;
      values.push({
        key: row.attributeKey,
        label: definition?.row.label ?? row.attributeKey,
        displayValue: row.sourceDisplayValue,
        valueType: definition?.row.valueType ?? 'string',
        ...(row.normalizedNumber === null ? {} : { normalizedNumber: row.normalizedNumber }),
        ...(row.normalizedNumberMax === null
          ? {}
          : { normalizedNumberMax: row.normalizedNumberMax }),
        ...(row.normalizedUnit === null ? {} : { normalizedUnit: row.normalizedUnit }),
        ...(row.normalizedText === null ? {} : { normalizedText: row.normalizedText }),
        ...(row.normalizedBoolean === null ? {} : { normalizedBoolean: row.normalizedBoolean }),
        ...(row.normalizedDate === null
          ? {}
          : { normalizedDate: row.normalizedDate.toISOString() }),
        ...(row.normalizedAmountMinor === null
          ? {}
          : { normalizedAmountMinor: row.normalizedAmountMinor }),
        ...(row.normalizedCurrency === null
          ? {}
          : { normalizedCurrency: row.normalizedCurrency }),
        ...(row.componentAxis === null ? {} : { componentAxis: row.componentAxis }),
        position: row.position,
        sourceBacked: true,
        verificationState: row.verificationState,
      });
    }
    sendSuccess(res, { entityKind, entityId, values });
  } catch (error) {
    respondWithError(res, error, 'Reading attribute values failed');
  }
}

/** POST /catalog-attributes/constraints/validate — check a set before searching. */
export async function validateConstraintsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ConstraintSetValidateBody;
    const set: ConstraintSet = { constraints: body.constraints as ProductConstraint[] };
    const validation = await validateConstraintSet(getDb(), set, {
      ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
    });

    if (validation.valid === false) {
      // 200 with `valid: false`, not 400. A constraint set that fails validation
      // is a well-formed REQUEST asking a question the catalogue cannot answer,
      // and the caller — a filter UI or #95's interpreter — needs the structured
      // issue list to re-plan. A 400 would make the issues an error body clients
      // parse inconsistently.
      sendSuccess(res, { valid: false, issues: validation.issues });
      return;
    }
    sendSuccess(res, {
      valid: true,
      warnings: validation.warnings,
      hardCount: validation.set.hard.length,
      preferenceCount: validation.set.preferences.length,
      evaluationVersion: validation.set.evaluationVersion,
      definitionVersions: validation.set.definitionVersions,
    });
  } catch (error) {
    respondWithError(res, error, 'Validating the constraint set failed');
  }
}

/**
 * POST /catalog-attributes/constraints/evaluate — one candidate, explained.
 *
 * Validation runs FIRST and its failure is returned instead of an evaluation: a
 * set that cannot be checked against the registry cannot be evaluated against a
 * product either, and evaluating it anyway would answer a question nobody could
 * state.
 */
export async function evaluateConstraintsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ConstraintSetEvaluateBody;
    const db = getDb();
    const validation = await validateConstraintSet(
      db,
      { constraints: body.constraints as ProductConstraint[] },
      { ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }) },
    );
    if (validation.valid === false) {
      sendSuccess(res, { valid: false, issues: validation.issues });
      return;
    }

    const facts = await loadCandidateFacts(body.productId, {
      offerContext: offerContextFor(body.currency, body.territory),
    });
    if (!facts) throw notFound(`Canonical product ${body.productId} does not exist.`);

    const evaluation = evaluateCandidate(validation.set, facts, {
      ...(body.variantId === undefined ? {} : { variantId: body.variantId }),
    });
    sendSuccess(res, {
      valid: true,
      warnings: validation.warnings,
      evaluation,
      explanation: explainEvaluation(evaluation),
    });
  } catch (error) {
    respondWithError(res, error, 'Evaluating the constraint set failed');
  }
}
