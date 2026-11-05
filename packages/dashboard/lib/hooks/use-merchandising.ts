import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMerchandisingRuleInput,
  MerchandisingPreviewInput,
  MerchandisingRule,
  UpdateMerchandisingRuleInput,
} from '@mercaria/shared-types';
import {
  createMerchandisingRule,
  deleteMerchandisingRule,
  fetchMerchandisingRule,
  fetchMerchandisingRules,
  previewMerchandising,
  updateMerchandisingRule,
} from '../api/merchandising';
import { queryKeys } from '../queryKeys';

export function useMerchandisingRules(storeId: string) {
  return useQuery<MerchandisingRule[]>({
    queryKey: queryKeys.merchandising.list(storeId),
    queryFn: () => fetchMerchandisingRules(storeId),
    enabled: Boolean(storeId),
  });
}

export function useMerchandisingRule(storeId: string, id: string) {
  return useQuery<MerchandisingRule>({
    queryKey: queryKeys.merchandising.detail(storeId, id),
    queryFn: () => fetchMerchandisingRule(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}

/**
 * After any write: the rules (statuses and precedence move together) and the
 * capability usage the Tools hub and `PlanUsage` show.
 */
function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.merchandising.all(storeId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.storeCapabilities(storeId) });
}

export function useCreateMerchandisingRule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMerchandisingRuleInput) => createMerchandisingRule(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

export function useUpdateMerchandisingRule(storeId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMerchandisingRuleInput) =>
      updateMerchandisingRule(storeId, id, input),
    onSuccess: (rule) => {
      queryClient.setQueryData(queryKeys.merchandising.detail(storeId, id), rule);
      invalidate(queryClient, storeId);
    },
  });
}

export function useDeleteMerchandisingRule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMerchandisingRule(storeId, id),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** The preview of a draft. `null` input (an incomplete draft) asks nothing. */
export function useMerchandisingPreview(storeId: string, input: MerchandisingPreviewInput | null) {
  return useQuery({
    queryKey: queryKeys.merchandising.preview(storeId, input),
    queryFn: () => previewMerchandising(storeId, input as MerchandisingPreviewInput),
    enabled: Boolean(storeId) && input !== null,
    placeholderData: (previous) => previous,
  });
}
