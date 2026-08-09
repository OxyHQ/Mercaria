/**
 * Condition operator controller (#90) — versioned source mappings, category
 * restrictions, and one listing's condition history.
 *
 * FIVE actions and no more, and the absences are the design:
 *
 *  - there is no "set this listing's condition". A condition is what a SELLER
 *    states about their own item; an operator overwriting it would make the row
 *    stop meaning that, and the correction path a seller drives already writes
 *    an audited revision.
 *  - there is no "approve this photograph in bulk". Moderation of listing
 *    imagery belongs to the CrowdSource path that already owns it, and a second
 *    approval surface here would be a second authority over one decision.
 *  - there is no "edit a published mapping". A correction is a NEW ruleset
 *    version, which is what lets an offer observed last month keep citing the
 *    rules it was actually read under.
 */

import type { Request, Response } from 'express';
import type {
  ConditionRestrictionReason,
  ConnectorProviderId,
  ItemConditionKey,
} from '@mercaria/shared-types';
import { normalizeSourceConditionLabel } from '@mercaria/shared-types';
import {
  countMappingsByRuleset,
  createRulesetDraft,
  findMappingsByRuleset,
  findRulesetById,
  findRulesetsByProvider,
  publishRuleset,
  replaceRulesetMappings,
} from '../db/condition/conditionMappingRepository.js';
import {
  deleteConditionCategoryPolicy,
  findPoliciesByCategory,
  upsertConditionCategoryPolicy,
} from '../db/condition/conditionPolicyRepository.js';
import { findConditionRevisions } from '../db/condition/conditionRepository.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { log } from '../lib/logger.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';

/** How many revisions one trace returns. A condition rarely moves more. */
const REVISION_PAGE_LIMIT = 50;

/** GET — every mapping ruleset for one provider, newest version first. */
export async function listConditionRulesetsHandler(req: Request, res: Response): Promise<void> {
  try {
    const provider = routeParam(req, 'provider') as ConnectorProviderId;
    const rulesets = await findRulesetsByProvider(provider);
    const withCounts = await Promise.all(
      rulesets.map(async (ruleset) => ({
        id: ruleset.id,
        provider: ruleset.provider,
        version: ruleset.version,
        state: ruleset.state,
        note: ruleset.note,
        publishedAt: ruleset.publishedAt?.toISOString(),
        ruleCount: await countMappingsByRuleset(ruleset.id),
      })),
    );
    sendSuccess(res, withCounts);
  } catch (err) {
    log.general.error({ err }, 'Failed to list condition mapping rulesets');
    respondWithError(res, err, 'Failed to list condition mapping rulesets');
  }
}

/** GET — one ruleset and its rules, including the sub-floor ones. */
export async function getConditionRulesetHandler(req: Request, res: Response): Promise<void> {
  try {
    const ruleset = await findRulesetById(routeParam(req, 'id'));
    if (!ruleset) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Mapping ruleset not found', 404);
      return;
    }
    const mappings = await findMappingsByRuleset(ruleset.id);
    sendSuccess(res, {
      id: ruleset.id,
      provider: ruleset.provider,
      version: ruleset.version,
      state: ruleset.state,
      note: ruleset.note,
      publishedAt: ruleset.publishedAt?.toISOString(),
      mappings: mappings.map((mapping) => ({
        sourceLabel: mapping.sourceLabel,
        sourceLabelNormalized: mapping.sourceLabelNormalized,
        conditionKey: mapping.conditionKey,
        confidence: mapping.confidence,
      })),
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to read condition mapping ruleset');
    respondWithError(res, err, 'Failed to read condition mapping ruleset');
  }
}

/** POST — open a new DRAFT version, one above the provider's highest. */
export async function createConditionRulesetHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { provider: ConnectorProviderId; note?: string };
    const ruleset = await createRulesetDraft(body.provider, body.note ?? null);
    log.general.info(
      { rulesetId: ruleset.id, provider: ruleset.provider, version: ruleset.version },
      '[Condition] mapping ruleset drafted',
    );
    sendSuccess(res, { id: ruleset.id, version: ruleset.version, state: ruleset.state }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to draft condition mapping ruleset');
    respondWithError(res, err, 'Failed to draft condition mapping ruleset');
  }
}

/**
 * PUT — replace a DRAFT's rules.
 *
 * The normalized lookup key is derived here rather than accepted from the
 * caller: two spellings of the normalization would be two answers to "which rule
 * matches this feed's wording", and only one of them is the one
 * `mapSourceCondition` uses at read time.
 */
export async function putConditionRulesetMappingsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const rulesetId = routeParam(req, 'id');
    const ruleset = await findRulesetById(rulesetId);
    if (!ruleset) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Mapping ruleset not found', 404);
      return;
    }
    if (ruleset.state !== 'draft') {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'A published mapping ruleset is immutable — draft a new version instead',
        409,
      );
      return;
    }

    const body = req.body as {
      mappings: { sourceLabel: string; conditionKey: ItemConditionKey; confidence: number }[];
    };
    const rows = await replaceRulesetMappings(
      rulesetId,
      body.mappings.map((mapping) => ({
        sourceLabel: mapping.sourceLabel,
        sourceLabelNormalized: normalizeSourceConditionLabel(mapping.sourceLabel),
        conditionKey: mapping.conditionKey,
        confidence: mapping.confidence,
      })),
    );
    sendSuccess(res, { rulesetId, ruleCount: rows.length });
  } catch (err) {
    log.general.error({ err }, 'Failed to replace condition mapping rules');
    respondWithError(res, err, 'Failed to replace condition mapping rules');
  }
}

/**
 * POST — publish a draft, superseding whatever was active.
 *
 * Nothing re-reads an existing observation. An offer keeps citing the version it
 * was actually read under until its source is observed again, which is what
 * "corrected without rewriting old observations" means (#90 migration rule 5).
 */
export async function publishConditionRulesetHandler(req: Request, res: Response): Promise<void> {
  try {
    const rulesetId = routeParam(req, 'id');
    const activated = await publishRuleset(rulesetId, catalogOperatorId(req), new Date());
    if (!activated) {
      sendError(res, ErrorCodes.CONFLICT, 'No draft mapping ruleset with that id', 409);
      return;
    }
    log.general.info(
      { rulesetId, provider: activated.provider, version: activated.version },
      '[Condition] mapping ruleset published',
    );
    sendSuccess(res, { id: activated.id, version: activated.version, state: activated.state });
  } catch (err) {
    log.general.error({ err }, 'Failed to publish condition mapping ruleset');
    respondWithError(res, err, 'Failed to publish condition mapping ruleset');
  }
}

/** GET — the restrictions recorded on one category. */
export async function listConditionCategoryPoliciesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const policies = await findPoliciesByCategory(routeParam(req, 'categoryId'));
    sendSuccess(
      res,
      policies.map((policy) => ({
        conditionKey: policy.conditionKey,
        restriction: policy.restriction,
        includeDescendants: policy.includeDescendants,
        reason: policy.reason,
      })),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list condition category policies');
    respondWithError(res, err, 'Failed to list condition category policies');
  }
}

/** PUT — record or correct one restriction (#90 policy rule 5). */
export async function putConditionCategoryPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      categoryId: string;
      conditionKey: ItemConditionKey;
      restriction: ConditionRestrictionReason;
      includeDescendants?: boolean;
      reason: string;
    };
    const policy = await upsertConditionCategoryPolicy({
      categoryId: body.categoryId,
      conditionKey: body.conditionKey,
      restriction: body.restriction,
      includeDescendants: body.includeDescendants ?? true,
      reason: body.reason,
      createdByOxyUserId: catalogOperatorId(req),
    });
    log.general.info(
      { categoryId: policy.categoryId, conditionKey: policy.conditionKey },
      '[Condition] category restriction recorded',
    );
    sendSuccess(res, { id: policy.id });
  } catch (err) {
    log.general.error({ err }, 'Failed to record condition category policy');
    respondWithError(res, err, 'Failed to record condition category policy');
  }
}

/** DELETE — lift one restriction. */
export async function deleteConditionCategoryPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const removed = await deleteConditionCategoryPolicy(
      routeParam(req, 'categoryId'),
      routeParam(req, 'conditionKey') as ItemConditionKey,
    );
    if (!removed) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such restriction', 404);
      return;
    }
    sendSuccess(res, { removed: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to lift condition category policy');
    respondWithError(res, err, 'Failed to lift condition category policy');
  }
}

/**
 * GET — one listing's condition history (#90 evidence rule 8).
 *
 * The revision trail and nothing else. It deliberately does NOT return the
 * evidence photographs: a file id list here would be an operator surface for
 * imagery beside the moderation path that already owns it.
 */
export async function traceListingConditionHandler(req: Request, res: Response): Promise<void> {
  try {
    const revisions = await findConditionRevisions(
      routeParam(req, 'listingId'),
      REVISION_PAGE_LIMIT,
    );
    sendSuccess(
      res,
      revisions.map((revision) => ({
        id: revision.id,
        fromCondition: revision.fromCondition,
        toCondition: revision.toCondition,
        fromAssertion: revision.fromAssertion,
        toAssertion: revision.toAssertion,
        actorKind: revision.actorKind,
        actorOxyUserId: revision.actorOxyUserId,
        reason: revision.reason,
        at: revision.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to trace listing condition history');
    respondWithError(res, err, 'Failed to trace listing condition history');
  }
}
