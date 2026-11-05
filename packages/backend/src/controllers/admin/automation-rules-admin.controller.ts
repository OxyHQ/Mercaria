/**
 * Automation rules controller (THIN) — `/admin/stores/:storeId/automations`
 * (#89, `automation_rules`).
 *
 * Every call is scoped to the loaded store (`req.store`, set by `loadStore`).
 * The plan decisions — a slot taken on create and given back on delete, the
 * capability asked on an edit — and the extra permission an order action needs
 * are the service's (`services/automation-rules/rule.service.ts`); a refusal is
 * a `PlanCapabilityRefusal`, which `respondWithError` answers as 403
 * `PLAN_CAPABILITY_REQUIRED` or `PLAN_LIMIT_REACHED`.
 */

import type { Request, Response } from 'express';
import type {
  CreateAutomationRuleInput,
  StorePermission,
  UpdateAutomationRuleInput,
} from '@mercaria/shared-types';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  listRuns,
  updateRule,
} from '../../services/automation-rules/rule.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { forbidden, notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

function storeId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

function permissions(req: Request): readonly StorePermission[] {
  const access = req.storeAccess;
  if (!access) throw forbidden('Store access required');
  return access.permissions;
}

/** GET /admin/stores/:storeId/automations — every rule of the store. */
export async function listAutomationRules(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listRules(storeId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to list automation rules');
    respondWithError(res, err, 'Failed to load automation rules');
  }
}

/** GET /admin/stores/:storeId/automations/runs — the run history, newest first. */
export async function listAutomationRuleRuns(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as { ruleId?: string; before?: string; limit?: number };
    sendSuccess(
      res,
      await listRuns(storeId(req), {
        ...(query.ruleId ? { ruleId: query.ruleId } : {}),
        ...(query.before ? { before: new Date(query.before) } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list automation rule runs');
    respondWithError(res, err, 'Failed to load the automation history');
  }
}

/** GET /admin/stores/:storeId/automations/:id — one rule. */
export async function getAutomationRule(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getRule(storeId(req), routeParam(req, 'id')));
  } catch (err) {
    respondWithError(res, err, 'Failed to load the automation rule');
  }
}

/** POST /admin/stores/:storeId/automations — create a rule (takes a plan slot). */
export async function createAutomationRule(req: Request, res: Response): Promise<void> {
  try {
    const rule = await createRule(storeId(req), req.body as CreateAutomationRuleInput, {
      oxyUserId: getRequiredOxyUserId(req),
      permissions: permissions(req),
    });
    sendSuccess(res, rule, 201);
  } catch (err) {
    log.general.warn({ err }, 'Failed to create automation rule');
    respondWithError(res, err, 'Failed to create the automation rule');
  }
}

/** PATCH /admin/stores/:storeId/automations/:id — edit, enable or disable a rule. */
export async function patchAutomationRule(req: Request, res: Response): Promise<void> {
  try {
    const rule = await updateRule(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateAutomationRuleInput,
      { permissions: permissions(req) },
    );
    sendSuccess(res, rule);
  } catch (err) {
    log.general.warn({ err }, 'Failed to update automation rule');
    respondWithError(res, err, 'Failed to update the automation rule');
  }
}

/** DELETE /admin/stores/:storeId/automations/:id — delete a rule (gives the slot back). */
export async function deleteAutomationRule(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await deleteRule(storeId(req), routeParam(req, 'id'), { permissions: permissions(req) }),
    );
  } catch (err) {
    log.general.warn({ err }, 'Failed to delete automation rule');
    respondWithError(res, err, 'Failed to delete the automation rule');
  }
}
