import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutomationRule,
  AutomationRuleRun,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@mercaria/shared-types';
import {
  createAutomationRule,
  deleteAutomationRule,
  fetchAutomationRules,
  fetchAutomationRuns,
  updateAutomationRule,
} from '../api/automations';
import { queryKeys } from '../queryKeys';

/** The store's automation rules. */
export function useAutomationRules(storeId: string) {
  return useQuery<AutomationRule[]>({
    queryKey: queryKeys.automations.list(storeId),
    queryFn: () => fetchAutomationRules(storeId),
    enabled: Boolean(storeId),
  });
}

/** The store's latest automation runs. Refreshed every minute, the evaluator's pace. */
export function useAutomationRuns(storeId: string) {
  return useQuery<AutomationRuleRun[]>({
    queryKey: queryKeys.automations.runs(storeId),
    queryFn: () => fetchAutomationRuns(storeId, { limit: 50 }),
    enabled: Boolean(storeId),
    refetchInterval: 60_000,
  });
}

/**
 * Every write changes the rule list AND the plan usage (a create takes a slot,
 * a delete gives one back), so both are refreshed.
 */
function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.automations.all(storeId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.storeCapabilities(storeId) });
}

export function useCreateAutomationRule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAutomationRuleInput) => createAutomationRule(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

export function useUpdateAutomationRule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAutomationRuleInput }) =>
      updateAutomationRule(storeId, id, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

export function useDeleteAutomationRule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAutomationRule(storeId, id),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}
