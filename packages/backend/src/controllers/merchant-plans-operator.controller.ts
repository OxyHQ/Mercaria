/**
 * Merchant plan and entitlement administration (#89) — the platform operator's
 * surface.
 *
 * Lives under `/internal/payments/*` behind the EXISTING
 * `requirePaymentOperator` gate rather than a seventh allow-list. Publishing a
 * plan is the same kind of act as publishing a fee schedule — a platform-wide
 * commercial decision no store membership can express — so it belongs to the
 * people already vetted for that, and a new list would grant it to whoever
 * happened to be added to it instead.
 *
 * ## Nothing here moves money
 *
 * A plan prices FUTURE subscriptions; an existing subscription names an
 * immutable version and is unaffected by anything on this surface. The one route
 * that touches a live merchant is the grant, which only ever ADDS a capability,
 * and its revocation — both audited, both attributable.
 *
 * ## The activation refusal is the point of the endpoint
 *
 * Activating a version whose entitlements name a capability this deployment has
 * not built is REFUSED, by name. That is "do not sell a placeholder plan whose
 * advertised features are not implemented" as a mechanism, and today it refuses
 * every paid plan that could be drafted, because all eight capabilities are
 * postponed.
 */

import type { Request, Response } from 'express';
import { isUniqueViolation } from '@oxyhq/db';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { getDb } from '../db/postgres.js';
import {
  activateMerchantPlan,
  insertMerchantPlan,
  insertMerchantPlanPrice,
  insertPlanEntitlement,
  listEntitlementDefinitions,
  listMerchantPlanPrices,
  listMerchantPlans,
  listPlanEntitlements,
  retireMerchantPlan,
} from '../db/merchantPlans/planRepository.js';
import {
  insertEntitlementGrant,
  listEntitlementGrants,
  revokeEntitlementGrant,
} from '../db/merchantPlans/grantRepository.js';
import { listSubscriptionEvents, findSubscriptionByStore } from '../db/merchantPlans/subscriptionRepository.js';
import { syncEntitlementDefinitions } from '../services/entitlements/catalog.js';
import {
  invalidateAllMerchantEntitlements,
  invalidateMerchantEntitlements,
  resolveMerchantEntitlements,
} from '../services/entitlements/resolve.js';
import { reconcileMerchantSubscriptions } from '../services/billing/subscription.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { conflict, notFound, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type {
  EntitlementGrantCreateBody,
  EntitlementGrantRevokeBody,
  MerchantPlanCreateBody,
  MerchantPlanPriceCreateBody,
  PlanEntitlementCreateBody,
} from '../middleware/merchant-plans-schemas.js';

/** GET /internal/payments/merchant-plans — every version of every plan. */
export async function listMerchantPlansHandler(req: Request, res: Response): Promise<void> {
  try {
    const planKey = typeof req.query.planKey === 'string' ? req.query.planKey : undefined;
    const db = getDb();
    const plans = await listMerchantPlans(db, planKey ? { planKey } : undefined);
    const planIds = plans.map((plan) => plan.id);
    const [prices, entitlements] = await Promise.all([
      listMerchantPlanPrices(db, { planIds }),
      listPlanEntitlements(db, planIds),
    ]);
    sendSuccess(res, {
      plans: plans.map((plan) => ({
        ...plan,
        prices: prices.filter((price) => price.planId === plan.id),
        entitlements: entitlements.filter((entitlement) => entitlement.planId === plan.id),
      })),
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to list merchant plans');
    respondWithError(res, err, 'Failed to list merchant plans');
  }
}

/** POST /internal/payments/merchant-plans — draft a new plan version. */
export async function createMerchantPlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as MerchantPlanCreateBody;
    const row = await insertMerchantPlan(getDb(), {
      planKey: body.planKey,
      version: body.version,
      tier: body.tier,
      name: body.name,
      summary: body.summary,
      termsVersion: body.termsVersion,
      ...(body.trialDays === undefined ? {} : { trialDays: body.trialDays }),
      ...(body.gracePeriodDays === undefined ? {} : { gracePeriodDays: body.gracePeriodDays }),
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { plan: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      respondWithError(
        res,
        conflict('That plan key and version already exist. Draft the next version instead.'),
        'Failed to draft the plan',
      );
      return;
    }
    log.general.error({ err }, 'Failed to draft a merchant plan');
    respondWithError(res, err, 'Failed to draft the plan');
  }
}

/** POST /internal/payments/merchant-plans/:id/prices — publish a provider price. */
export async function createMerchantPlanPriceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as MerchantPlanPriceCreateBody;
    const row = await insertMerchantPlanPrice(getDb(), {
      planId: routeParam(req, 'id'),
      provider: 'stripe',
      livemode: body.livemode,
      interval: body.interval,
      unitPrice: { amount: body.amount, currency: body.currency },
      providerPriceId: body.providerPriceId,
    });
    sendSuccess(res, { price: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      respondWithError(
        res,
        conflict('That plan version already publishes a price for this mode, cadence and currency.'),
        'Failed to publish the price',
      );
      return;
    }
    log.general.error({ err }, 'Failed to publish a plan price');
    respondWithError(res, err, 'Failed to publish the price');
  }
}

/** POST /internal/payments/merchant-plans/:id/entitlements — grant a capability. */
export async function createPlanEntitlementHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as PlanEntitlementCreateBody;
    const row = await insertPlanEntitlement(getDb(), {
      planId: routeParam(req, 'id'),
      capabilityKey: body.capability,
      limitKind: body.limitKind,
      ...(body.limit === undefined ? {} : { limitValue: body.limit }),
    });
    sendSuccess(res, { entitlement: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      respondWithError(
        res,
        conflict('That plan version already grants this capability.'),
        'Failed to add the entitlement',
      );
      return;
    }
    log.general.error({ err }, 'Failed to add a plan entitlement');
    respondWithError(res, err, 'Failed to add the entitlement');
  }
}

/** POST /internal/payments/merchant-plans/:id/activate — publish a draft. */
export async function activateMerchantPlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const outcome = await activateMerchantPlan(getDb(), {
      id: routeParam(req, 'id'),
      approvedByOxyUserId: getRequiredOxyUserId(req),
    });
    if (outcome.outcome === 'not_a_draft') {
      respondWithError(
        res,
        conflict('That plan version is not a draft, so there is nothing to activate.'),
        'Failed to activate the plan',
      );
      return;
    }
    if (outcome.outcome === 'postponed_capabilities') {
      respondWithError(
        res,
        conflict(
          'That plan version grants capabilities this deployment has not implemented: ' +
            `${outcome.capabilities.join(', ')}. A plan whose advertised features do not exist ` +
            'is not put on sale.',
        ),
        'Failed to activate the plan',
      );
      return;
    }
    invalidateAllMerchantEntitlements();
    sendSuccess(res, { plan: outcome.plan });
  } catch (err) {
    log.general.error({ err }, 'Failed to activate a merchant plan');
    respondWithError(res, err, 'Failed to activate the plan');
  }
}

/** POST /internal/payments/merchant-plans/:id/retire — withdraw a version. */
export async function retireMerchantPlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await retireMerchantPlan(getDb(), routeParam(req, 'id'));
    if (!row) {
      respondWithError(
        res,
        conflict('Only an active version or an unpublished draft can be retired.'),
        'Failed to retire the plan',
      );
      return;
    }
    invalidateAllMerchantEntitlements();
    sendSuccess(res, { plan: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to retire a merchant plan');
    respondWithError(res, err, 'Failed to retire the plan');
  }
}

/** GET /internal/payments/merchant-plans/definitions — the capability catalogue. */
export async function listEntitlementDefinitionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, { definitions: await listEntitlementDefinitions(getDb()) });
  } catch (err) {
    log.general.error({ err }, 'Failed to list entitlement definitions');
    respondWithError(res, err, 'Failed to list capabilities');
  }
}

/**
 * POST /internal/payments/merchant-plans/definitions/sync — publish the CODE
 * catalogue into the database.
 *
 * An explicit act rather than a boot-time write, so a deployment that shipped a
 * capability and never synced it FAILS CLOSED — the definition stays
 * `postponed`, every check refuses, and nothing goes on sale by accident.
 */
export async function syncEntitlementDefinitionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, { definitions: await syncEntitlementDefinitions(getDb()) });
  } catch (err) {
    log.general.error({ err }, 'Failed to sync entitlement definitions');
    respondWithError(res, err, 'Failed to sync capabilities');
  }
}

/**
 * GET /internal/payments/merchant-plans/stores/:storeId — one store's trace.
 *
 * Opens from a STORE id and nothing else. There is no lookup by capability, by
 * plan or by subscription state, because "which merchants hold this capability"
 * is a question about a commercial cohort that this surface has no reason to be
 * able to ask.
 */
export async function traceStoreEntitlementsHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = routeParam(req, 'storeId');
    const db = getDb();
    const resolved = await resolveMerchantEntitlements(storeId, { fresh: true, db });
    const subscription = await findSubscriptionByStore(db, storeId);
    const grants = await listEntitlementGrants(db, storeId);
    const events = subscription
      ? await listSubscriptionEvents(db, { subscriptionId: subscription.id, limit: 100 })
      : [];
    sendSuccess(res, {
      storeId,
      planKey: resolved.planKey,
      planVersion: resolved.planVersion,
      subscriptionStatus: resolved.subscriptionStatus,
      graceExpiresAt: resolved.graceExpiresAt,
      entitlements: [...resolved.entitlements.values()],
      grants,
      events,
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to trace store entitlements');
    respondWithError(res, err, 'Failed to trace the entitlements');
  }
}

/** POST /internal/payments/entitlement-grants — grant a capability outside a plan. */
export async function createEntitlementGrantHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as EntitlementGrantCreateBody;
    const { created, row } = await insertEntitlementGrant(getDb(), {
      storeId: body.storeId,
      grantKey: body.grantKey,
      capabilityKey: body.capability,
      limitKind: body.limitKind,
      ...(body.limit === undefined ? {} : { limitValue: body.limit }),
      reason: body.reason,
      note: body.note,
      grantedByOxyUserId: getRequiredOxyUserId(req),
      startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
      ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
    });
    invalidateMerchantEntitlements(body.storeId);
    sendSuccess(res, { grant: row, created }, created ? 201 : 200);
  } catch (err) {
    log.general.error({ err }, 'Failed to grant an entitlement');
    respondWithError(res, err, 'Failed to grant the capability');
  }
}

/** POST /internal/payments/entitlement-grants/:id/revoke — withdraw a grant. */
export async function revokeEntitlementGrantHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as EntitlementGrantRevokeBody;
    const row = await revokeEntitlementGrant(getDb(), {
      id: routeParam(req, 'id'),
      revokedByOxyUserId: getRequiredOxyUserId(req),
      revocationReason: body.reason,
    });
    if (!row) {
      respondWithError(
        res,
        notFound('No live grant with that id.'),
        'Failed to revoke the grant',
      );
      return;
    }
    invalidateMerchantEntitlements(row.storeId);
    sendSuccess(res, { grant: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to revoke an entitlement grant');
    respondWithError(res, err, 'Failed to revoke the grant');
  }
}

/**
 * POST /internal/payments/merchant-subscriptions/reconcile — run one sweep page.
 *
 * The single-item equivalent of the periodic loop, for an operator working an
 * incident with the loop switched off. It drives the SAME path a webhook does,
 * so it adds no way to change a subscription that did not already exist.
 */
export async function reconcileMerchantSubscriptionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await reconcileMerchantSubscriptions());
  } catch (err) {
    log.general.error({ err }, 'Failed to reconcile merchant subscriptions');
    respondWithError(res, err, 'Failed to reconcile');
  }
}
