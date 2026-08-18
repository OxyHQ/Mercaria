/**
 * The translation desk's handlers (#367 merge-order step 10).
 *
 * ## Read-only, and the omissions are the design
 *
 * Three GETs and nothing else. In particular there is **no route that settles a
 * translation**, and that is not an oversight: reviewing one already exists at
 * `POST /internal/catalog-governance/reviews/localization`, behind this same
 * allow-list and additionally narrowed by the `translate` role grant, writing
 * the `catalog_review_events` and `catalog_governance_audit_events` trail. A
 * second route to one decision is how two surfaces come to disagree about what
 * it meant — the reasoning `/internal/catalog-governance`'s own header gives for
 * refusing a second proposal-decision route.
 *
 * So this surface tells a desk WHAT to work on and the governance surface is
 * where the work is recorded. There is also no "recompute", because nothing is
 * stored to recompute: both reports are derived at read time.
 *
 * ## No id belonging to a person reaches these responses
 *
 * The completeness and alert payloads are integers and closed-set keys. The
 * review payload carries `reviewedByOxyUserId` — a reviewer's own account id,
 * which is the audit half of "who settled this sentence" and is what the
 * localization family stores it for. No buyer, seller or shopper id appears
 * anywhere in this domain.
 */

import type { Request, Response } from 'express';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { log } from '../lib/logger.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  readLocalizationAlerts,
  readLocalizationCompleteness,
  type CompletenessLocaleScope,
} from '../services/catalog-localization/completeness.service.js';
import { reviewLocalization } from '../services/catalog-localization/side-by-side.service.js';
import {
  LOCALIZED_ENTITY_KINDS,
  type LocalizedEntityKind,
  type SupportedLocale,
} from '@mercaria/shared-types';

/**
 * `GET /internal/catalog-localization/completeness` — every covered domain
 * against every locale in scope, with the report's own coverage beside it.
 */
export async function localizationCompletenessHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const scope = (req.query.scope as CompletenessLocaleScope | undefined) ?? 'launch';
    sendSuccess(res, await readLocalizationCompleteness(scope));
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogLocalization] completeness report failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not read localization completeness', 500);
  }
}

/**
 * `GET /internal/catalog-localization/alerts` — the launch-locale gaps.
 *
 * Scoped to the launch locales by the service's own construction rather than by
 * a parameter, so there is no query a caller could pass to be alerted about a
 * locale no app ships.
 */
export async function localizationAlertsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readLocalizationAlerts());
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogLocalization] alert evaluation failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not evaluate localization alerts', 500);
  }
}

/**
 * `GET /internal/catalog-localization/review/:domain/:entityId` — source beside
 * target for one entity in one locale.
 *
 * A 404 for an entity that does not exist, which is the service's `undefined`
 * passed through rather than an empty comparison: "this category has no Spanish
 * name" and "there is no such category" are different facts and rendering the
 * second as the first would show a reviewer an empty form for nothing.
 */
export async function localizationReviewHandler(req: Request, res: Response): Promise<void> {
  try {
    // Express params are `string | string[]` when a path repeats a segment name
    // — the case `validateId` documents and normalizes the same way.
    const rawDomain = Array.isArray(req.params.domain) ? req.params.domain[0] : req.params.domain;
    // Checked against the closed set BEFORE any read. `validate.ts` exports no
    // params validator and this is the only route that wants one, so the check
    // lives here rather than as a new shared helper — a membership test against
    // the frozen tuple, which is what a schema would have done.
    const domains: readonly string[] = LOCALIZED_ENTITY_KINDS;
    if (!domains.includes(rawDomain)) {
      sendError(
        res,
        ErrorCodes.VALIDATION_ERROR,
        `domain must be one of: ${LOCALIZED_ENTITY_KINDS.join(', ')}`,
        400,
      );
      return;
    }
    const domain = rawDomain as LocalizedEntityKind;
    const entityId = Array.isArray(req.params.entityId)
      ? req.params.entityId[0]
      : req.params.entityId;
    const locale = req.query.locale as SupportedLocale;
    const comparison = await reviewLocalization(domain, entityId, locale);
    if (!comparison) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such entity', 404);
      return;
    }
    sendSuccess(res, comparison);
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogLocalization] review read failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not read localization review', 500);
  }
}
