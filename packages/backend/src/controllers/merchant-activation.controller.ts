/**
 * The merchant activation surface (#85) — merchant, individual seller and
 * operator.
 *
 * Three audiences and three projections, and the split is deliberate:
 *
 *  - a MERCHANT sees its own readiness, capabilities, onboarding steps and the
 *    fact that a hold exists — never the hold's stated reason, which is an
 *    operator's note about a moderation or risk finding;
 *  - an individual SELLER sees only the policies that apply to a person, because
 *    it has no store and #112's criterion is the whole of what it needs;
 *  - an OPERATOR sees the same state plus the hold detail and the transition
 *    trail.
 *
 * Nothing here computes anything. Every verdict comes from
 * `services/merchant-activation/`, so the dashboard, the checkout gate and the
 * operator trace cannot disagree — one code path asked three ways, #88's rule.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  MerchantActivationPolicy,
  MerchantActivationTrace,
} from '@mercaria/shared-types';
import { MERCHANT_ACTIVATION_POLICIES } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { listPolicyAcceptancesForOwner } from '../db/merchantActivation/policyAcceptanceRepository.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import {
  deriveMerchantActivation,
  projectActivationState,
  readMerchantActivationState,
} from '../services/merchant-activation/activation.service.js';
import {
  acceptActivationPolicy,
  holdStoreActivation,
  readPlatformHoldDetail,
  releaseStoreActivationHold,
  updateMerchantActivationSettings,
} from '../services/merchant-activation/settings.service.js';
import {
  observeMerchantActivation,
  readActivationTransitions,
} from '../services/merchant-activation/transitions.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  AcceptActivationPolicyBody,
  HoldStoreActivationBody,
  UpdateActivationSettingsBody,
} from '../middleware/merchant-activation-schemas.js';

/** How many transitions an operator trace returns. Bounded, never a full history. */
const TRACE_LIMIT = 200;

/** The loaded store for the current request (guaranteed by `loadStore`). */
function loadedStoreId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

/**
 * The operator routes' store id.
 *
 * `validateId` on the route has already refused a malformed one; this narrows
 * express's `string | string[]` rather than asserting it away, because a
 * duplicated query-style parameter is a real request shape and answering it with
 * a cast would hand an array to a repository.
 */
function pathStoreId(req: Request): string {
  const storeId = req.params.storeId;
  if (typeof storeId !== 'string' || storeId.length === 0) {
    throw validationError('A store id is required');
  }
  return storeId;
}

/** GET /admin/stores/:storeId/activation — the merchant's own readiness. */
export async function getStoreActivationHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readMerchantActivationState(loadedStoreId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to read merchant activation state');
    respondWithError(res, err, 'Failed to read activation readiness');
  }
}

/**
 * PATCH /admin/stores/:storeId/activation — a merchant pauses, resumes or
 * publishes a support contact.
 *
 * The response is the RE-DERIVED state rather than the row that was written, so
 * a merchant who pauses guest checkout immediately sees what that did to every
 * capability. A client that trusted its own optimistic update would be showing a
 * verdict the server did not make, which is what capability rule 2 forbids.
 */
export async function updateStoreActivationHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = loadedStoreId(req);
    await updateMerchantActivationSettings({
      storeId,
      patch: req.body as UpdateActivationSettingsBody,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, await readMerchantActivationState(storeId));
  } catch (err) {
    log.general.error({ err }, 'Failed to update merchant activation settings');
    respondWithError(res, err, 'Failed to update activation settings');
  }
}

/** POST /admin/stores/:storeId/activation/policies — a store accepts a policy. */
export async function acceptStorePolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = loadedStoreId(req);
    const body = req.body as AcceptActivationPolicyBody;
    const result = await acceptActivationPolicy({
      policyKey: body.policyKey,
      policyVersion: body.policyVersion,
      ownerType: 'store',
      ownerId: storeId,
      acceptedByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, await readMerchantActivationState(storeId), result.created ? 201 : 200);
  } catch (err) {
    log.general.error({ err }, 'Failed to record an activation policy acceptance');
    respondWithError(res, err, 'Failed to record the policy acceptance');
  }
}

/**
 * GET /seller/activation/policies — what an INDIVIDUAL seller must accept.
 *
 * The surface #88 recorded as #85's and #112 named as its one `unevaluable`
 * criterion. It carries no store, no readiness verdict and no capability: a
 * person selling a bicycle has no store to be ready, and #112's decision is that
 * guest P2P stays refused whatever they accept. What the acceptance changes is
 * that the criterion is answerable, which is what the decision document said it
 * was waiting for.
 */
export async function getSellerActivationPoliciesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const accepted = await listPolicyAcceptancesForOwner({ ownerType: 'user', ownerId: oxyUserId });
    const published = Object.values(MERCHANT_ACTIVATION_POLICIES).filter(
      (policy: MerchantActivationPolicy) => policy.appliesTo === 'user',
    );
    sendSuccess(
      res,
      published.map((policy) => {
        const row = accepted.find(
          (candidate) =>
            candidate.policyKey === policy.key && candidate.policyVersion === policy.version,
        );
        return {
          policyKey: policy.key,
          policyVersion: policy.version,
          accepted: row !== undefined,
          acceptedAt: row?.createdAt.toISOString(),
        };
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to read seller activation policies');
    respondWithError(res, err, 'Failed to read the seller policies');
  }
}

/** POST /seller/activation/policies — an individual seller accepts a policy. */
export async function acceptSellerPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as AcceptActivationPolicyBody;
    const result = await acceptActivationPolicy({
      policyKey: body.policyKey,
      policyVersion: body.policyVersion,
      ownerType: 'user',
      ownerId: oxyUserId,
      acceptedByOxyUserId: oxyUserId,
    });
    sendSuccess(
      res,
      { policyKey: body.policyKey, policyVersion: body.policyVersion, acceptedAt: result.acceptedAt },
      result.created ? 201 : 200,
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to accept a seller activation policy');
    respondWithError(res, err, 'Failed to record the policy acceptance');
  }
}

/**
 * GET /internal/commerce-graph/activation/:storeId — the operator trace.
 *
 * Opens from a STORE ID and nothing else. There is no route that takes an
 * account, an order or an email, so "which merchants has this person activated"
 * is not a question this surface can be asked.
 */
export async function getActivationTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = pathStoreId(req);
    const derived = await deriveMerchantActivation(storeId);
    if (!derived) throw notFound('Store not found');
    const hold = await readPlatformHoldDetail(storeId);
    const trace: MerchantActivationTrace = {
      state: projectActivationState(derived),
      transitions: await readActivationTransitions(storeId, TRACE_LIMIT),
      ...(hold
        ? {
            platformHoldReason: hold.reason,
            platformHeldByOxyUserId: hold.heldByOxyUserId,
            platformHeldAt: hold.heldAt,
          }
        : {}),
    };
    sendSuccess(res, trace);
  } catch (err) {
    log.general.error({ err }, 'Failed to trace merchant activation');
    respondWithError(res, err, 'Failed to trace activation');
  }
}

/** POST /internal/commerce-graph/activation/:storeId/hold — an operator holds a store. */
export async function holdActivationHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = pathStoreId(req);
    const body = req.body as HoldStoreActivationBody;
    await holdStoreActivation({
      storeId,
      reason: body.reason,
      operatorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { storeId, held: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to hold merchant activation');
    respondWithError(res, err, 'Failed to hold the store');
  }
}

/** DELETE /internal/commerce-graph/activation/:storeId/hold — release it. */
export async function releaseActivationHoldHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = pathStoreId(req);
    await releaseStoreActivationHold({
      storeId,
      operatorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { storeId, held: false });
  } catch (err) {
    log.general.error({ err }, 'Failed to release a merchant activation hold');
    respondWithError(res, err, 'Failed to release the hold');
  }
}

/**
 * POST /internal/commerce-graph/activation/:storeId/observe — record any
 * transition the sweep has not yet noticed.
 *
 * The ONE operator write that is not a hold, and it DRIVES an existing
 * idempotent path rather than adding a way to change anything: it re-derives and
 * appends whatever moved. There is deliberately no "set this capability", no
 * "mark this requirement satisfied" and no "activate this store" — every one
 * would be a way to grant a capability the derivation refuses, which is the
 * whole thing #85 acceptance 2 asks to be impossible.
 */
export async function observeActivationHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = pathStoreId(req);
    const transitions = await observeMerchantActivation(storeId, {
      kind: 'operator',
      oxyUserId: getRequiredOxyUserId(req),
      cause: 'operator_reevaluation',
    });
    sendSuccess(res, { storeId, transitions, sweepEnabled: config.merchantActivation.observationEnabled });
  } catch (err) {
    log.general.error({ err }, 'Failed to observe merchant activation');
    respondWithError(res, err, 'Failed to observe activation');
  }
}
