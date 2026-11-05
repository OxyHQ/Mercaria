import { useQuery } from '@tanstack/react-query';
import type { PosRegisterList } from '@mercaria/shared-types';
import { fetchPosRegisters } from '../api/pos-registers';
import { queryKeys } from '../queryKeys';

/**
 * The named registers at a location (the paid `expanded_pos_registers` tool).
 * A store without any — every free store — answers an empty list, and the POS
 * rings up on the location's default register exactly as before.
 */
export function usePosRegisters(storeId: string, locationId: string | null) {
  return useQuery<PosRegisterList>({
    queryKey: queryKeys.posRegisters(storeId, locationId ?? ''),
    queryFn: () => fetchPosRegisters(storeId, locationId ?? ''),
    enabled: Boolean(storeId) && Boolean(locationId),
  });
}
