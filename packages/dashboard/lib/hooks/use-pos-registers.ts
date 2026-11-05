import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePosRegisterInput,
  PosRegisterList,
  PosRegisterSalesSummary,
} from '@mercaria/shared-types';
import {
  createPosRegister,
  fetchPosRegisterSummary,
  fetchPosRegisters,
  removePosRegister,
  renamePosRegister,
} from '../api/pos-registers';
import { queryKeys } from '../queryKeys';

/** The store's named registers (archived included) and whether sales are attributed now. */
export function usePosRegisters(storeId: string) {
  return useQuery<PosRegisterList>({
    queryKey: queryKeys.posRegisters.list(storeId),
    queryFn: () => fetchPosRegisters(storeId),
    enabled: Boolean(storeId),
  });
}

/** Daily sales per register over `[from, to]`. */
export function usePosRegisterSummary(storeId: string, from: string, to: string, enabled = true) {
  return useQuery<PosRegisterSalesSummary>({
    queryKey: queryKeys.posRegisters.summary(storeId, from, to),
    queryFn: () => fetchPosRegisterSummary(storeId, { from, to }),
    enabled: Boolean(storeId) && enabled,
  });
}

/**
 * A register write changes the list AND the plan usage the gate shows, so both
 * are refreshed — the usage lives under `plan`.
 */
function useInvalidateRegisters(storeId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.posRegisters.all(storeId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.storeCapabilities(storeId) });
  };
}

export function useCreatePosRegister(storeId: string) {
  const invalidate = useInvalidateRegisters(storeId);
  return useMutation({
    mutationFn: (input: CreatePosRegisterInput) => createPosRegister(storeId, input),
    onSuccess: invalidate,
  });
}

export function useRenamePosRegister(storeId: string) {
  const invalidate = useInvalidateRegisters(storeId);
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renamePosRegister(storeId, id, name),
    onSuccess: invalidate,
  });
}

export function useRemovePosRegister(storeId: string) {
  const invalidate = useInvalidateRegisters(storeId);
  return useMutation({
    mutationFn: (id: string) => removePosRegister(storeId, id),
    onSuccess: invalidate,
  });
}
