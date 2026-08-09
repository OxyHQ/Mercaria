/**
 * Retail pricing policy administration (#120) — the platform operator surface.
 *
 * Lives under `/internal/payments/*` behind `requirePaymentOperator`, beside
 * the fee-schedule surface and for the same reason: "what does Mercaria charge
 * for the goods it sells itself" is a platform-wide decision, and no store
 * membership can express it. Nothing here moves money — a policy version prices
 * quotes composed after it, and every composed quote keeps its immutable
 * snapshot whatever happens in this file.
 *
 * The audit is structural, exactly as the fee surface's is: `created_by` on the
 * draft, `approved_by` + `activated_at` on the activation (a CHECK refuses an
 * anonymous active row), and the immutability trigger makes "edit an active
 * policy" impossible for this surface and for every other client.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../db/postgres.js';
import {
  activateRetailPricingPolicy,
  insertRetailPricingPolicy,
  listRetailPricingPolicies,
  retireRetailPricingPolicy,
  type RetailPricingPolicyRecord,
} from '../db/retailPricing/retailPricingPolicyRepository.js';
import {
  assertRetailPolicyBodyIsCostOnly,
  toRetailPricingPolicySummary,
} from '../services/retail-pricing/retail-pricing-policy.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { conflict, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { RetailPricingPolicyCreateBody } from '../middleware/retail-pricing-schemas.js';

/** The operator projection: the DTO plus the row id and the audit columns. */
function operatorView(row: RetailPricingPolicyRecord) {
  return {
    id: row.id,
    ...toRetailPricingPolicySummary(row),
    createdByOxyUserId: row.createdByOxyUserId,
    ...(row.approvedByOxyUserId ? { approvedByOxyUserId: row.approvedByOxyUserId } : {}),
  };
}

/** GET /internal/payments/retail-pricing-policies — every version of every policy. */
export async function listRetailPricingPoliciesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const policyKey = typeof req.query.policyKey === 'string' ? req.query.policyKey : undefined;
    const rows = await listRetailPricingPolicies(getDb(), policyKey ? { policyKey } : undefined);
    sendSuccess(res, { policies: rows.map(operatorView) });
  } catch (err) {
    log.general.error({ err }, 'Failed to list retail pricing policies');
    respondWithError(res, err, 'Failed to list retail pricing policies');
  }
}

/**
 * POST /internal/payments/retail-pricing-policies — draft a new version.
 *
 * The forbidden-component check runs against `req.body` and not against the
 * validated body, deliberately: by the time zod has parsed it, a `markupBps`
 * has already been refused as an unrecognized key, and the operator would be
 * told they made a typo rather than that retail carries zero markup by
 * construction. This surface answers the second thing.
 */
export async function createRetailPricingPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    assertRetailPolicyBodyIsCostOnly(req.body);
    const body = req.body as RetailPricingPolicyCreateBody;
    const row = await insertRetailPricingPolicy(getDb(), {
      policyKey: body.policyKey,
      version: body.version,
      name: body.name,
      summary: body.summary,
      effectiveStart: new Date(body.effectiveStart),
      ...(body.effectiveEnd ? { effectiveEnd: new Date(body.effectiveEnd) } : {}),
      allowedComponentKinds: body.allowedComponentKinds,
      ...(body.paymentCostPassthroughEnabled !== undefined
        ? { paymentCostPassthroughEnabled: body.paymentCostPassthroughEnabled }
        : {}),
      ...(body.paymentCostPassthroughBasis
        ? { paymentCostPassthroughBasis: body.paymentCostPassthroughBasis }
        : {}),
      ...(body.absorptionCapBps !== undefined ? { absorptionCapBps: body.absorptionCapBps } : {}),
      ...(body.absorptionCapFloorMinor !== undefined && body.absorptionCapFloorCurrency
        ? {
            absorptionCapFloor: {
              amount: body.absorptionCapFloorMinor,
              currency: body.absorptionCapFloorCurrency,
            },
          }
        : {}),
      ...(body.roundingToleranceMinor !== undefined
        ? { roundingToleranceMinor: body.roundingToleranceMinor }
        : {}),
      ...(body.quoteTtlSeconds !== undefined ? { quoteTtlSeconds: body.quoteTtlSeconds } : {}),
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, operatorView(row), 201);
  } catch (err) {
    if (isUniqueViolation(err, 'retail_pricing_policies_key_version_key')) {
      respondWithError(
        res,
        conflict('That policy key and version already exist; draft the next version number.'),
        'Failed to draft the retail pricing policy',
      );
      return;
    }
    log.general.error({ err }, 'Failed to draft a retail pricing policy');
    respondWithError(res, err, 'Failed to draft the retail pricing policy');
  }
}

/**
 * POST /internal/payments/retail-pricing-policies/:id/activate — publish a
 * draft, superseding the key's current active version in the same transaction.
 */
export async function activateRetailPricingPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await activateRetailPricingPolicy(getDb(), {
      id: routeParam(req, 'id'),
      approvedByOxyUserId: getRequiredOxyUserId(req),
    });
    if (!row) {
      throw conflict('Only a draft policy version can be activated.');
    }
    sendSuccess(res, operatorView(row));
  } catch (err) {
    log.general.error({ err }, 'Failed to activate a retail pricing policy');
    respondWithError(res, err, 'Failed to activate the retail pricing policy');
  }
}

/** POST /internal/payments/retail-pricing-policies/:id/retire — withdraw it. */
export async function retireRetailPricingPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await retireRetailPricingPolicy(getDb(), routeParam(req, 'id'));
    if (!row) {
      throw conflict('Only an active or draft policy version can be retired.');
    }
    sendSuccess(res, operatorView(row));
  } catch (err) {
    log.general.error({ err }, 'Failed to retire a retail pricing policy');
    respondWithError(res, err, 'Failed to retire the retail pricing policy');
  }
}
