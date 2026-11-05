import type { ApiResponse, PosRegisterList } from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/** GET the live named registers at one location, and whether sales honour them now. */
export async function fetchPosRegisters(
  storeId: string,
  locationId: string,
): Promise<PosRegisterList> {
  const { data } = await apiClient.get<ApiResponse<PosRegisterList>>(
    `/admin/stores/${storeId}/pos-registers`,
    { params: { locationId } },
  );
  return unwrap(data);
}
