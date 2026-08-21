/**
 * Secondary classification operator controller (#367 Workstream 1).
 *
 * FOUR actions, and the absences are the design:
 *
 *  - there is no "set the primary category". That is `listings.category_id` and
 *    `canonical_products.category_id`, written by `catalog-write.service` and
 *    `canonical-product.service`. A second door onto one column is how a
 *    seller's filing and an operator's quietly diverge, and neither of those
 *    services is bypassed here.
 *  - there is no "promote this secondary to primary". It would be the same
 *    write in a costume, and it would have to decide what happens to the
 *    displaced primary — a decision belonging to whoever owns the subject.
 *  - there is no bulk file. Every row carries a justification somebody is
 *    accountable for, and a bulk endpoint is how one justification gets pasted
 *    across two hundred products, which is the decorative-justification failure
 *    the NOT NULL CHECK exists to prevent.
 *  - there is no "list every subject filed under this category". The COUNT is
 *    served (an operator needs it before deprecating a node) and the list is
 *    not: this surface exists to govern the taxonomy, not to enumerate a
 *    seller's catalogue through it.
 */

import type { Request, Response } from 'express';
import type {
  ClassificationSubjectKind,
  SecondaryClassificationReason,
} from '@mercaria/shared-types';
import { CLASSIFICATION_SUBJECT_KINDS } from '@mercaria/shared-types';
import {
  readCategoryClassificationUsage,
  readProductClassification,
  recordSecondaryClassification,
  withdrawSecondaryClassification,
} from '../services/taxonomy/classification.service.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { validationError } from '../lib/errors/error-codes.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/**
 * The `:subjectKind` path segment, validated against the shared tuple.
 *
 * A route parameter is a string from the wire, so this is the boundary where it
 * becomes the union. Validating it here rather than casting is what stops
 * `/internal/taxonomy/classifications/canonical_variant/...` reaching a
 * repository lookup keyed on a table that does not exist for it.
 */
function subjectKindParam(req: Request): ClassificationSubjectKind {
  const raw = routeParam(req, 'subjectKind');
  if (!(CLASSIFICATION_SUBJECT_KINDS as readonly string[]).includes(raw)) {
    throw validationError(
      `Unknown subject kind “${raw}”. Expected one of: ${CLASSIFICATION_SUBJECT_KINDS.join(', ')}.`,
    );
  }
  return raw as ClassificationSubjectKind;
}

/** GET — the primary plus every secondary for one subject. */
export async function getProductClassificationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const subjectKind = subjectKindParam(req);
    const subjectId = routeParam(req, 'subjectId');
    sendSuccess(res, await readProductClassification(subjectKind, subjectId));
  } catch (error) {
    respondWithError(res, error, 'Failed to read classification');
  }
}

/**
 * POST — file one secondary classification.
 *
 * `justifiedBy` comes from the CREDENTIAL, never the body: an operator must not
 * be able to file a decision in a colleague's name, and the request schema
 * refuses the field so the intent is stated rather than implied.
 */
export async function createSecondaryClassificationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const subjectKind = subjectKindParam(req);
    const subjectId = routeParam(req, 'subjectId');
    const body = req.body as {
      categoryId: string;
      reason: string;
      justification: string;
      schemeRef?: string;
    };

    const created = await recordSecondaryClassification({
      subjectKind,
      subjectId,
      categoryId: body.categoryId,
      reason: body.reason as SecondaryClassificationReason,
      justification: body.justification,
      ...(body.schemeRef === undefined ? {} : { schemeRef: body.schemeRef }),
      justifiedBy: catalogOperatorId(req),
    });

    sendSuccess(res, created, 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to record classification');
  }
}

/** DELETE — withdraw one secondary classification. */
export async function deleteSecondaryClassificationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const subjectKind = subjectKindParam(req);
    const subjectId = routeParam(req, 'subjectId');
    const categoryId = routeParam(req, 'categoryId');
    await withdrawSecondaryClassification(subjectKind, subjectId, categoryId);
    sendSuccess(res, { withdrawn: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to withdraw classification');
  }
}

/**
 * GET — how many subjects name this category as a SECONDARY.
 *
 * The reader `*_secondary_categories_category_idx` exists for, and the figure
 * an operator needs before deprecating or merging a node: `impact-plan.ts`
 * declares both references `blocks`, so this is what says how much is blocked.
 */
export async function getCategoryClassificationUsageHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const categoryId = routeParam(req, 'categoryId');
    sendSuccess(res, await readCategoryClassificationUsage(categoryId));
  } catch (error) {
    respondWithError(res, error, 'Failed to read category usage');
  }
}
