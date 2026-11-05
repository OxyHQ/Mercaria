import type {
  ApiResponse,
  CreatePosRegisterInput,
  PosRegister,
  PosRegisterList,
  PosRegisterRemoval,
  PosRegisterSalesSummary,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

const base = (storeId: string) => `/admin/stores/${storeId}/pos-registers`;

/** GET the store's named registers, archived ones included (the summary names them). */
export async function fetchPosRegisters(storeId: string): Promise<PosRegisterList> {
  const { data } = await apiClient.get<ApiResponse<PosRegisterList>>(base(storeId), {
    params: { includeArchived: 'true' },
  });
  return unwrap(data);
}

/** POST a named register — takes one of the plan's allowance. */
export async function createPosRegister(
  storeId: string,
  input: CreatePosRegisterInput,
): Promise<PosRegister> {
  const { data } = await apiClient.post<ApiResponse<PosRegister>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a register's name. */
export async function renamePosRegister(
  storeId: string,
  id: string,
  name: string,
): Promise<PosRegister> {
  const { data } = await apiClient.patch<ApiResponse<PosRegister>>(`${base(storeId)}/${id}`, {
    name,
  });
  return unwrap(data);
}

/** DELETE a register — deleted if it never took a sale, archived if it did. */
export async function removePosRegister(storeId: string, id: string): Promise<PosRegisterRemoval> {
  const { data } = await apiClient.delete<ApiResponse<PosRegisterRemoval>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}

/** GET the daily sales per register, the default register included. */
export async function fetchPosRegisterSummary(
  storeId: string,
  params: { from: string; to: string },
): Promise<PosRegisterSalesSummary> {
  const { data } = await apiClient.get<ApiResponse<PosRegisterSalesSummary>>(
    `${base(storeId)}/summary`,
    { params },
  );
  return unwrap(data);
}
