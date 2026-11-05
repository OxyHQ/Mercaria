import type {
  ApiResponse,
  AutomationRule,
  AutomationRuleRun,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/** A store's automation rules (#89, `automation_rules`). */
const base = (storeId: string) => `/admin/stores/${storeId}/automations`;

/** GET every rule of the store. Never refused by the plan. */
export async function fetchAutomationRules(storeId: string): Promise<AutomationRule[]> {
  const { data } = await apiClient.get<ApiResponse<AutomationRule[]>>(base(storeId));
  return unwrap(data);
}

/** GET the store's run history, newest first. */
export async function fetchAutomationRuns(
  storeId: string,
  params: { ruleId?: string; limit?: number } = {},
): Promise<AutomationRuleRun[]> {
  const { data } = await apiClient.get<ApiResponse<AutomationRuleRun[]>>(`${base(storeId)}/runs`, {
    params,
  });
  return unwrap(data);
}

/** POST a new rule. Takes one slot of the plan's allowance. */
export async function createAutomationRule(
  storeId: string,
  input: CreateAutomationRuleInput,
): Promise<AutomationRule> {
  const { data } = await apiClient.post<ApiResponse<AutomationRule>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a rule — edit it, or turn it on or off. */
export async function updateAutomationRule(
  storeId: string,
  id: string,
  input: UpdateAutomationRuleInput,
): Promise<AutomationRule> {
  const { data } = await apiClient.patch<ApiResponse<AutomationRule>>(
    `${base(storeId)}/${id}`,
    input,
  );
  return unwrap(data);
}

/** DELETE a rule. Gives its slot back. */
export async function deleteAutomationRule(
  storeId: string,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}
