/**
 * Automation rules: writing, reading and deleting a store's rules (#89,
 * `automation_rules`, limit kind `total`).
 *
 * ## What the plan meters, and when
 *
 * The allowance is the NUMBER of rules a store has. Creating one takes a slot
 * with `consumeCapabilityOrThrow` in the insert's own transaction; deleting one
 * gives it back with `releaseCapability` in the delete's transaction, and only
 * when the delete actually removed a row. Disabling keeps the slot.
 *
 * What a refusal never reaches: listing, reading, disabling and deleting a rule,
 * and reading its run history. A store whose plan ended keeps every rule it
 * wrote; the evaluator simply stops running them, and the merchant can still
 * tidy them up. Editing or enabling a rule asks `requireCapability` — a rule
 * the store may not run is not one worth reshaping — and at the ceiling that
 * still answers yes, because the slot is already the store's.
 *
 * ## The permission a rule needs is the permission its action needs
 *
 * Every rule write sits behind `products:write` at the route. A rule whose
 * action moves an ORDER (`mark_order_processing`) additionally needs
 * `orders:fulfill`, the permission a member needs to make that move by hand —
 * so a rule can never do what its author could not.
 */

import {
  AUTOMATION_RULE_ACTIONS_BY_TRIGGER,
  assertSafeMoneyAmount,
  type AutomationRule,
  type AutomationRuleAction,
  type AutomationRuleRun,
  type AutomationRuleTrigger,
  type CreateAutomationRuleInput,
  type CurrencyCode,
  type StorePermission,
  type UpdateAutomationRuleInput,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import {
  deleteAutomationRule,
  findAutomationRule,
  insertAutomationRule,
  listAutomationRuleRuns,
  listAutomationRules,
  updateAutomationRule,
  type AutomationRulePatch,
  type AutomationRuleRow,
  type AutomationRuleRunRow,
} from '../../db/automationRules/automationRuleRepository.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  consumeCapabilityOrThrow,
  releaseCapability,
  requireCapability,
} from '../entitlements/enforce.js';

/** The capability every function here meters. */
export const AUTOMATION_RULES_CAPABILITY = 'automation_rules' as const;

/** The extra store permission an action needs beyond `products:write`, if any. */
const ACTION_PERMISSION: Readonly<Record<AutomationRuleAction, StorePermission | null>> = {
  notify_owner: null,
  pause_listing: null,
  mark_order_processing: 'orders:fulfill',
};

/** Refuse a member who could not perform the rule's action by hand. */
export function assertMayManageAction(
  permissions: readonly StorePermission[],
  action: AutomationRuleAction,
): void {
  const needed = ACTION_PERMISSION[action];
  if (needed !== null && !permissions.includes(needed)) {
    throw forbidden(`Missing permission: ${needed}`);
  }
}

/** The rule's shape after a create or an edit — what the CHECKs will see. */
interface RuleShape {
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  stockThreshold: number | null;
  tag: string | null;
  minOrderTotal: { amount: number; currency: CurrencyCode } | null;
  republishWhenRestocked: boolean;
}

/**
 * Refuse a shape the table would refuse, with a message naming the field —
 * the CHECKs stay the authority, this is what makes the answer a 400 rather
 * than a 500.
 */
function assertRuleShape(shape: RuleShape, storeCurrency: CurrencyCode): void {
  if (!AUTOMATION_RULE_ACTIONS_BY_TRIGGER[shape.trigger].includes(shape.action)) {
    throw validationError(`A ${shape.trigger} rule cannot ${shape.action}.`);
  }
  if (shape.trigger === 'listing_stock_at_or_below') {
    if (shape.stockThreshold === null) {
      throw validationError('A stock rule needs a stock threshold.');
    }
    if (shape.minOrderTotal !== null) {
      throw validationError('Only an order rule can have a minimum order total.');
    }
  } else if (shape.stockThreshold !== null) {
    throw validationError('Only a stock rule can have a stock threshold.');
  }
  if (shape.republishWhenRestocked && shape.action !== 'pause_listing') {
    throw validationError('Only a rule that pauses listings can republish them.');
  }
  if (shape.minOrderTotal !== null) {
    assertSafeMoneyAmount(shape.minOrderTotal.amount, 'automation rule minimum order total');
    if (shape.minOrderTotal.currency !== storeCurrency) {
      // Orders are totalled in the store's own currency and nothing converts at
      // `paid`, so a minimum in any other currency would never match anything.
      throw validationError(`The minimum order total must be in ${storeCurrency}.`);
    }
  }
}

function normalizeTag(tag: string | null | undefined): string | null {
  const trimmed = tag?.trim();
  return trimmed ? trimmed : null;
}

async function storeCurrencyOf(storeId: string): Promise<CurrencyCode> {
  const store = await findStoreById(storeId);
  if (!store) throw notFound('Store not found');
  return store.defaultCurrency as CurrencyCode;
}

/** The rule as the dashboard reads it. */
export function toAutomationRuleDTO(row: AutomationRuleRow): AutomationRule {
  return {
    id: row.id,
    storeId: row.storeId,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    action: row.action,
    stockThreshold: row.stockThreshold,
    tag: row.tag,
    minOrderTotal:
      row.minOrderTotalAmount !== null && row.minOrderTotalCurrency !== null
        ? { amount: row.minOrderTotalAmount, currency: row.minOrderTotalCurrency }
        : null,
    republishWhenRestocked: row.republishWhenRestocked,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One run as the dashboard reads it. */
export function toAutomationRuleRunDTO(row: AutomationRuleRunRow): AutomationRuleRun {
  return {
    id: row.id,
    ruleId: row.ruleId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    step: row.step,
    outcome: row.outcome,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every rule of the store. Never gated. */
export async function listRules(storeId: string): Promise<AutomationRule[]> {
  return (await listAutomationRules(storeId)).map(toAutomationRuleDTO);
}

/** One rule of the store, or NOT_FOUND. Never gated. */
export async function getRule(storeId: string, ruleId: string): Promise<AutomationRule> {
  const row = await findAutomationRule(storeId, ruleId);
  if (!row) throw notFound('Automation rule not found');
  return toAutomationRuleDTO(row);
}

/** The store's run history, newest first. Never gated. */
export async function listRuns(
  storeId: string,
  input: { ruleId?: string; before?: Date; limit?: number },
): Promise<AutomationRuleRun[]> {
  const rows = await listAutomationRuleRuns({
    storeId,
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    ...(input.before ? { before: input.before } : {}),
    limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
  });
  return rows.map(toAutomationRuleRunDTO);
}

/**
 * Create a rule, taking one slot of the store's allowance in the SAME
 * transaction as the insert: a refusal writes nothing, and a failed insert
 * gives the slot back by rolling back with it.
 */
export async function createRule(
  storeId: string,
  input: CreateAutomationRuleInput,
  actor: { oxyUserId: string; permissions: readonly StorePermission[] },
): Promise<AutomationRule> {
  assertMayManageAction(actor.permissions, input.action);
  const shape: RuleShape = {
    trigger: input.trigger,
    action: input.action,
    stockThreshold: input.stockThreshold ?? null,
    tag: normalizeTag(input.tag),
    minOrderTotal: input.minOrderTotal ?? null,
    republishWhenRestocked: input.republishWhenRestocked ?? false,
  };
  assertRuleShape(shape, await storeCurrencyOf(storeId));

  const row = await getDb().transaction(async (tx) => {
    await consumeCapabilityOrThrow(tx, { storeId, capability: AUTOMATION_RULES_CAPABILITY });
    return insertAutomationRule(tx, {
      storeId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      trigger: shape.trigger,
      action: shape.action,
      stockThreshold: shape.stockThreshold,
      tag: shape.tag,
      minOrderTotalAmount: shape.minOrderTotal?.amount ?? null,
      minOrderTotalCurrency: shape.minOrderTotal?.currency ?? null,
      republishWhenRestocked: shape.republishWhenRestocked,
      armedAt: new Date(),
      createdByOxyUserId: actor.oxyUserId,
    });
  });
  return toAutomationRuleDTO(row);
}

/**
 * Edit a rule. Turning a rule OFF is never gated — it can only reduce what runs.
 * Anything else asks whether the store still holds the capability. Turning a
 * rule back ON re-arms it, so an order rule never reaches back over the orders
 * paid while it was off.
 */
export async function updateRule(
  storeId: string,
  ruleId: string,
  input: UpdateAutomationRuleInput,
  actor: { permissions: readonly StorePermission[] },
): Promise<AutomationRule> {
  const existing = await findAutomationRule(storeId, ruleId);
  if (!existing) throw notFound('Automation rule not found');
  assertMayManageAction(actor.permissions, existing.action);

  const onlyDisables =
    Object.keys(input).every((key) => key === 'enabled') && input.enabled === false;
  if (!onlyDisables) {
    await requireCapability({ storeId, capability: AUTOMATION_RULES_CAPABILITY });
  }

  const current = toAutomationRuleDTO(existing);
  const shape: RuleShape = {
    trigger: existing.trigger,
    action: existing.action,
    stockThreshold:
      input.stockThreshold !== undefined ? input.stockThreshold : current.stockThreshold,
    tag: input.tag !== undefined ? normalizeTag(input.tag) : current.tag,
    minOrderTotal: input.minOrderTotal !== undefined ? input.minOrderTotal : current.minOrderTotal,
    republishWhenRestocked: input.republishWhenRestocked ?? current.republishWhenRestocked,
  };
  if (!onlyDisables) assertRuleShape(shape, await storeCurrencyOf(storeId));

  const patch: AutomationRulePatch = {
    stockThreshold: shape.stockThreshold,
    tag: shape.tag,
    minOrderTotalAmount: shape.minOrderTotal?.amount ?? null,
    minOrderTotalCurrency: shape.minOrderTotal?.currency ?? null,
    republishWhenRestocked: shape.republishWhenRestocked,
  };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    if (input.enabled && !existing.enabled) patch.armedAt = new Date();
  }

  const row = await updateAutomationRule(getDb(), storeId, ruleId, patch);
  if (!row) throw notFound('Automation rule not found');
  return toAutomationRuleDTO(row);
}

/**
 * Delete a rule and give its slot back, in one transaction. Never gated. The
 * listings a stock rule paused stay `draft`: deleting a rule undoes nothing
 * the merchant has not asked it to.
 */
export async function deleteRule(
  storeId: string,
  ruleId: string,
  actor: { permissions: readonly StorePermission[] },
): Promise<{ id: string; deleted: true }> {
  const existing = await findAutomationRule(storeId, ruleId);
  if (!existing) throw notFound('Automation rule not found');
  assertMayManageAction(actor.permissions, existing.action);

  const deleted = await getDb().transaction(async (tx) => {
    const row = await deleteAutomationRule(tx, storeId, ruleId);
    if (row) await releaseCapability(tx, { storeId, capability: AUTOMATION_RULES_CAPABILITY });
    return row;
  });
  if (!deleted) throw notFound('Automation rule not found');
  return { id: ruleId, deleted: true };
}
