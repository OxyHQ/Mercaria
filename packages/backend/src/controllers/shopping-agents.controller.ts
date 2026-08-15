/**
 * HTTP for the saved shopping-agent surface (#97).
 *
 * Every handler reads the acting account from the VERIFIED credential
 * (`getRequiredOxyUserId`) and never from the body, the query or a header — so
 * "an agent belongs to the person who made it" is a property of where the id
 * comes from rather than of a check somebody wrote.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  ConditionGroup,
  ConstraintSet,
  CurrencyCode,
  ProductConstraint,
  ShoppingAgentChannelPolicy,
  ShoppingAgentJobKind,
  ShoppingAgentNotificationChannel,
  ShoppingAgentPriceBasis,
  ShoppingAgentQuietHours,
  ShoppingAgentSplitResolution,
  ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { log } from '../lib/logger.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { refuseForbiddenAgentAction } from '../services/shopping-agents/authorization.js';
import {
  createShoppingAgent,
  deleteShoppingAgent,
  getShoppingAgent,
  listShoppingAgents,
  requestShoppingAgentRun,
  resolveShoppingAgentSplitChoice,
  updateShoppingAgent,
} from '../services/shopping-agents/agent.service.js';
import { listShoppingAgentFindingsForOwner } from '../services/shopping-agents/finding.service.js';
import { readShoppingAgentMetrics } from '../services/shopping-agents/operator.service.js';

interface CreateBody {
  readonly kind: ShoppingAgentJobKind;
  readonly name: string;
  readonly description?: string;
  readonly displayCurrency: CurrencyCode;
  readonly priceBasis?: ShoppingAgentPriceBasis;
  readonly channelPolicy?: ShoppingAgentChannelPolicy;
  readonly market?: string;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly excludedMerchantIds?: readonly string[];
  readonly target?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly lines: readonly {
    readonly canonicalProductId: string;
    readonly canonicalVariantId?: string;
    readonly quantity?: number;
    readonly conditionGroups?: readonly ConditionGroup[];
    readonly merchantId?: string;
  }[];
  readonly constraints: readonly ProductConstraint[];
  readonly constraintDigest: string;
  readonly triggerSources?: readonly ShoppingAgentTriggerSource[];
  readonly scheduleIntervalSeconds?: number;
  readonly notificationChannels?: readonly ShoppingAgentNotificationChannel[];
  readonly cooldownSeconds?: number;
  readonly quietHours?: ShoppingAgentQuietHours;
  readonly locale?: string;
}

interface UpdateBody {
  readonly name?: string;
  readonly description?: string;
  readonly state?: 'enabled' | 'paused';
  readonly cooldownSeconds?: number;
  readonly quietHours?: ShoppingAgentQuietHours;
  readonly locale?: string;
  readonly notificationChannels?: readonly ShoppingAgentNotificationChannel[];
  readonly constraints?: readonly ProductConstraint[];
  readonly constraintDigest?: string;
}

/**
 * Refuse a request that asks the system to ACT, naming what it found.
 *
 * Mounted BEFORE the `.strict()` schema, so the answer is the prohibition
 * rather than "Unrecognized key" — #121's `forbidden-evidence.ts`, and the
 * difference between a client author reading "we do not support that field" and
 * reading "this system does not do that".
 */
export function refuseForbiddenAgentActionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const found = refuseForbiddenAgentAction(req.body);
  if (found === null) {
    next();
    return;
  }
  respondWithError(
    res,
    validationError(
      `A saved agent cannot ${found.replace(/_/g, ' ')}. Agents observe the catalogue and tell you what they find; they never act on your behalf.`,
    ),
    'That request asks for something a saved agent cannot do',
  );
}

export async function createShoppingAgentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as CreateBody;
    const constraints: ConstraintSet = { constraints: body.constraints };
    const agent = await createShoppingAgent({
      oxyUserId,
      kind: body.kind,
      name: body.name,
      ...(body.description === undefined ? {} : { description: body.description }),
      displayCurrency: body.displayCurrency,
      ...(body.priceBasis === undefined ? {} : { priceBasis: body.priceBasis }),
      ...(body.channelPolicy === undefined ? {} : { channelPolicy: body.channelPolicy }),
      ...(body.market === undefined ? {} : { market: body.market }),
      ...(body.conditionGroups === undefined ? {} : { conditionGroups: body.conditionGroups }),
      ...(body.excludedMerchantIds === undefined
        ? {}
        : { excludedMerchantIds: body.excludedMerchantIds }),
      ...(body.target === undefined ? {} : { target: body.target }),
      lines: body.lines,
      constraints,
      constraintDigest: body.constraintDigest,
      ...(body.triggerSources === undefined ? {} : { triggerSources: body.triggerSources }),
      ...(body.scheduleIntervalSeconds === undefined
        ? {}
        : { scheduleIntervalSeconds: body.scheduleIntervalSeconds }),
      ...(body.notificationChannels === undefined
        ? {}
        : { notificationChannels: body.notificationChannels }),
      ...(body.cooldownSeconds === undefined ? {} : { cooldownSeconds: body.cooldownSeconds }),
      ...(body.quietHours === undefined ? {} : { quietHours: body.quietHours }),
      ...(body.locale === undefined ? {} : { locale: body.locale }),
    });
    sendSuccess(res, { agent }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create a shopping agent');
    respondWithError(res, err, 'Failed to save that agent');
  }
}

export async function listShoppingAgentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const limit = typeof req.query.limit === 'number' ? req.query.limit : undefined;
    const agents = await listShoppingAgents(oxyUserId, limit);
    sendSuccess(res, { agents });
  } catch (err) {
    log.general.error({ err }, 'Failed to list shopping agents');
    respondWithError(res, err, 'Failed to load your agents');
  }
}

export async function getShoppingAgentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const agent = await getShoppingAgent(oxyUserId, routeParam(req, 'agentId'));
    sendSuccess(res, { agent });
  } catch (err) {
    log.general.error({ err }, 'Failed to read a shopping agent');
    respondWithError(res, err, 'Failed to load that agent');
  }
}

export async function updateShoppingAgentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as UpdateBody;
    const agent = await updateShoppingAgent(oxyUserId, routeParam(req, 'agentId'), {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.state === undefined ? {} : { state: body.state }),
      ...(body.cooldownSeconds === undefined ? {} : { cooldownSeconds: body.cooldownSeconds }),
      ...(body.quietHours === undefined ? {} : { quietHours: body.quietHours }),
      ...(body.locale === undefined ? {} : { locale: body.locale }),
      ...(body.notificationChannels === undefined
        ? {}
        : { notificationChannels: body.notificationChannels }),
      ...(body.constraints === undefined
        ? {}
        : { constraints: { constraints: body.constraints } }),
      ...(body.constraintDigest === undefined
        ? {}
        : { constraintDigest: body.constraintDigest }),
    });
    sendSuccess(res, { agent });
  } catch (err) {
    log.general.error({ err }, 'Failed to update a shopping agent');
    respondWithError(res, err, 'Failed to update that agent');
  }
}

export async function deleteShoppingAgentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await deleteShoppingAgent(oxyUserId, routeParam(req, 'agentId'));
    sendSuccess(res, { deleted: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to delete a shopping agent');
    respondWithError(res, err, 'Failed to delete that agent');
  }
}

/** 202: a run is REQUESTED. The queue converges; nothing is evaluated inline. */
export async function runShoppingAgentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await requestShoppingAgentRun(oxyUserId, routeParam(req, 'agentId'));
    sendSuccess(res, { requested: true }, 202);
  } catch (err) {
    log.general.error({ err }, 'Failed to request a shopping-agent run');
    respondWithError(res, err, 'Failed to request that run');
  }
}

export async function resolveShoppingAgentSplitHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as { readonly resolution: ShoppingAgentSplitResolution };
    const agent = await resolveShoppingAgentSplitChoice(
      oxyUserId,
      routeParam(req, 'agentId'),
      body.resolution,
    );
    sendSuccess(res, { agent });
  } catch (err) {
    log.general.error({ err }, 'Failed to resolve a shopping-agent split');
    respondWithError(res, err, 'Failed to resolve that change');
  }
}

export async function listShoppingAgentFindingsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const limit = typeof req.query.limit === 'number' ? req.query.limit : undefined;
    const findings = await listShoppingAgentFindingsForOwner(
      oxyUserId,
      routeParam(req, 'agentId'),
      limit,
    );
    sendSuccess(res, { findings });
  } catch (err) {
    log.general.error({ err }, 'Failed to list shopping-agent findings');
    respondWithError(res, err, 'Failed to load those findings');
  }
}

/** The operator surface: aggregates only. See `routes/internal-shopping-agents.ts`. */
export async function shoppingAgentMetricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const metrics = await readShoppingAgentMetrics();
    sendSuccess(res, { metrics });
  } catch (err) {
    log.general.error({ err }, 'Failed to read shopping-agent metrics');
    respondWithError(res, err, 'Failed to load those metrics');
  }
}
